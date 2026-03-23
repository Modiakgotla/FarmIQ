// supabase/functions/analyze/index.ts
// ═══════════════════════════════════════════════════════════════
//  FarmIQ — Supabase Edge Function: Claude AI Proxy
//
//  Deploy:  supabase functions deploy analyze
//  Secrets: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//           supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...
//
//  Flow:
//  1. Verify caller has a valid Supabase JWT
//  2. Check they haven't exceeded their monthly limit
//  3. Call Claude API server-side (key never touches the browser)
//  4. Increment their usage counter via service-role client
// ═══════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FREE_LIMIT = 3;
const PRO_LIMIT  = 9999;

serve(async (req: Request) => {
  // ── CORS preflight ─────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    // ── 1. Require Authorization header ────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonError("Missing or malformed Authorization header", 401);
    }

    // ── 2. Verify JWT with a user-scoped client ─────────────────
    // This client uses the user's JWT so RLS policies apply.
    const supabaseUrl  = Deno.env.get("SUPABASE_URL");
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnon) {
      return jsonError("Server misconfiguration: missing Supabase env vars", 500);
    }

    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return jsonError("Invalid or expired session — please sign in again", 401);
    }

    // ── 3. Load profile and check usage ────────────────────────
    const { data: profile, error: profileError } = await userClient
      .from("profiles")
      .select("plan, analyses_this_month, month_reset")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      console.error("Profile fetch error:", profileError);
      return jsonError("Profile not found — try signing out and back in", 404);
    }

    // BUG FIX: Supabase returns date columns as "YYYY-MM-DD" strings.
    // Appending T00:00:00Z forces UTC parsing so month comparisons are
    // consistent regardless of what timezone the Edge Function runs in.
    const now        = new Date();
    const resetStr   = String(profile.month_reset).slice(0, 10);
    const monthReset = new Date(`${resetStr}T00:00:00Z`);

    const isNewMonth =
      now.getUTCFullYear() > monthReset.getUTCFullYear() ||
      now.getUTCMonth()    > monthReset.getUTCMonth();

    const currentUsage = isNewMonth ? 0 : (profile.analyses_this_month ?? 0);
    const limit        = profile.plan === "free" ? FREE_LIMIT : PRO_LIMIT;

    if (currentUsage >= limit) {
      return jsonError(
        `Monthly limit reached (${limit} analyses on your ${profile.plan} plan). Upgrade to Pro for unlimited analyses.`,
        429
      );
    }

    // ── 4. Parse and validate request body ─────────────────────
    let body: { prompt?: string };
    try {
      body = await req.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const { prompt } = body;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return jsonError("Missing or empty prompt", 400);
    }
    if (prompt.length > 8000) {
      return jsonError("Prompt too long (max 8000 characters)", 400);
    }

    // ── 5. Call Claude API ─────────────────────────────────────
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      console.error("ANTHROPIC_API_KEY secret is not set");
      return jsonError("AI service not configured on server", 500);
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 1200,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error("Claude API error:", claudeRes.status, errText);
      return jsonError("AI service error — please try again in a moment", 502);
    }

    const claudeData = await claudeRes.json();
    const result: string =
      claudeData.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";

    if (!result) {
      console.error("Claude returned empty content:", JSON.stringify(claudeData));
      return jsonError("AI returned an empty response — please retry", 502);
    }

    // ── 6. Increment usage counter via service-role client ──────
    // BUG FIX: The user-scoped client above cannot UPDATE profiles
    // due to RLS (only SELECT is allowed for the user's own row).
    // The service role key bypasses RLS for this one admin write.
    // Without it the counter silently never increments.
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) {
      console.warn("SUPABASE_SERVICE_ROLE_KEY not set — usage counter not incremented. Add it with: supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...");
    } else {
      const adminClient = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false },
      });

      const { error: updateError } = await adminClient
        .from("profiles")
        .update({
          analyses_this_month: currentUsage + 1,
          ...(isNewMonth && { month_reset: now.toISOString().slice(0, 10) }),
        })
        .eq("id", user.id);

      if (updateError) {
        // Non-fatal — advisory is still returned, log for debugging
        console.error("Usage counter update failed:", updateError);
      }
    }

    // ── 7. Return result ────────────────────────────────────────
    return new Response(
      JSON.stringify({ result, usage: { current: currentUsage + 1, limit } }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Unhandled edge function error:", err);
    return jsonError("Internal server error", 500);
  }
});

function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
}