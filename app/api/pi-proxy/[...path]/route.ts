import { NextRequest, NextResponse } from "next/server";
import { loadSettings } from "@/lib/settings-store";

function sanitizeResponseText(text: string, contentType: string | null): string {
  if (!contentType) return text;
  
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.choices && Array.isArray(parsed.choices)) {
        for (const choice of parsed.choices) {
          if (choice.message && typeof choice.message.content === "string") {
            choice.message.content = choice.message.content
              .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
              .replace(/<think>[\s\S]*?<\/think>/gi, "")
              .trim();
          }
        }
        return JSON.stringify(parsed);
      }
    } catch (e) {
      // Fail-safe: if JSON parsing fails, just return original text
    }
  } else if (contentType.includes("text/event-stream")) {
    try {
      const lines = text.split("\n");
      let inThought = false;
      const newLines = lines.map(line => {
        if (!line.startsWith("data: ")) return line;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") return line;
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.choices && Array.isArray(parsed.choices)) {
            for (const choice of parsed.choices) {
              if (choice.delta && typeof choice.delta.content === "string") {
                let content = choice.delta.content;
                
                // Track thought state
                if (content.includes("<thought>") || content.includes("<think>")) {
                  inThought = true;
                }
                const hasEnd = content.includes("</thought>") || content.includes("</think>");
                
                if (inThought) {
                  content = content
                    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
                    .replace(/<think>[\s\S]*?<\/think>/gi, "");
                  if (inThought && !hasEnd) {
                    content = "";
                  }
                }
                if (hasEnd) {
                  inThought = false;
                }
                choice.delta.content = content;
              }
            }
            return `data: ${JSON.stringify(parsed)}`;
          }
        } catch {
          // ignore
        }
        return line;
      });
      return newLines.join("\n");
    } catch {
      // ignore
    }
  }
  
  return text;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const settings = loadSettings();
  let url = settings.piUrl;
  
  if (!url) {
    return new NextResponse(JSON.stringify({ error: { message: "No BYOK URL configured" } }), { status: 500 });
  }

  try {
    const body = await req.json();

    // Strip fields that are not supported by some OpenAI-compatible endpoints (like Google Gemini)
    if (body.store !== undefined) delete body.store;
    if (body.reasoning_effort !== undefined) delete body.reasoning_effort;

    // Reconstruct the target URL
    const resolvedParams = await params;
    const pathSuffix = (resolvedParams.path || []).join("/");
    
    // Cleanly merge overlapping path segments to prevent duplicating versions (e.g., /v1beta/v1beta)
    const base = new URL(url);
    const baseSegments = base.pathname.split("/").filter(Boolean);
    const suffixSegments = pathSuffix.split("/").filter(Boolean);
    
    let overlapCount = 0;
    const maxOverlap = Math.min(baseSegments.length, suffixSegments.length);
    for (let i = 1; i <= maxOverlap; i++) {
      const baseSlice = baseSegments.slice(-i);
      const suffixSlice = suffixSegments.slice(0, i);
      if (baseSlice.join("/") === suffixSlice.join("/")) {
        overlapCount = i;
      }
    }
    
    const mergedSegments = [...baseSegments, ...suffixSegments.slice(overlapCount)];
    base.pathname = "/" + mergedSegments.join("/");
    
    // Keep any incoming query parameters
    const incomingUrl = new URL(req.url);
    incomingUrl.searchParams.forEach((value, key) => {
      base.searchParams.append(key, value);
    });
    const targetUrl = base.toString();

    const headers = new Headers();
    
    // Copy incoming headers that are safe and needed
    for (const [key, value] of req.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.startsWith("anthropic-") ||
        lowerKey.startsWith("x-goog-") ||
        lowerKey === "user-agent" ||
        lowerKey === "accept"
      ) {
        headers.set(key, value);
      }
    }
    
    headers.set("Content-Type", "application/json");

    if (settings.piApiKey) {
      const isGemini = targetUrl.includes("generativelanguage.googleapis.com") || settings.piApiType === "google-generative-ai";
      const isAnthropic = targetUrl.includes("api.anthropic.com") || settings.piApiType === "anthropic-messages";
      
      if (isGemini) {
        headers.set("x-goog-api-key", settings.piApiKey);
        headers.delete("authorization");
      } else if (isAnthropic) {
        headers.set("x-api-key", settings.piApiKey);
        headers.delete("authorization");
        if (!headers.has("anthropic-version")) {
          headers.set("anthropic-version", "2023-06-01");
        }
      } else {
        headers.set("Authorization", `Bearer ${settings.piApiKey}`);
      }
    }

    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    const contentType = response.headers.get("Content-Type");

    // If it's a successful streaming response, pipe it directly to the client.
    // Buffering a 2-minute stream with await response.text() causes the client
    // (pi-coding-agent) to timeout and throw "Incomplete JSON segment at the end".
    if (response.status === 200 && contentType?.includes("text/event-stream")) {
      return new NextResponse(response.body, {
        status: response.status,
        headers: {
          "Content-Type": contentType
        }
      });
    }

    let text = await response.text();

    // Clean up thought/thinking blocks if it's a successful non-streaming response
    if (response.status === 200) {
      text = sanitizeResponseText(text, contentType);
    }

    // Some endpoints (like Google Gemini OpenAI layer) might return errors wrapped in an array: `[{ "error": ... }]`
    // The OpenAI SDK in pi-coding-agent expects a direct object: `{ "error": ... }`.
    // If we detect a 400 with an array wrapper, we unwrap it so the agent can parse the error message instead of "(no body)".
    if (response.status >= 400 && text.startsWith("[") && text.endsWith("]")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].error) {
          text = JSON.stringify(parsed[0]);
        }
      } catch (e) {
        // Ignore parse errors, just return original text
      }
    }

    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type": contentType || "application/json"
      }
    });

  } catch (err: any) {
    return new NextResponse(JSON.stringify({ error: { message: `Proxy Error: ${err.message}` } }), { status: 500 });
  }
}
