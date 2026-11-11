const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "*";
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
  if (allowed === "*") headers["access-control-allow-origin"] = "*";
  else if (origin === allowed) headers["access-control-allow-origin"] = origin;
  return headers;
}

async function authenticateUser(request, env) {
  const token = request.headers.get("Authorization") || "";
  if (!token.startsWith("Bearer ") || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: token,
    },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user?.id ? user : null;
}

async function saveMessage(env, userId, role, content) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/nexus_messages`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({ user_id: userId, role, content }),
  });
  if (!response.ok) throw new Error(`Supabase save failed (${response.status})`);
}

async function getRecentMessages(env, userId) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/nexus_messages`);
  url.searchParams.set("select", "role,content");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "12");
  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) throw new Error(`Supabase read failed (${response.status})`);
  return (await response.json()).reverse();
}

async function generateWithGemini(env, history, message) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const contents = [
    ...history.map((item) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: item.content }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: env.NEXUS_SYSTEM_PROMPT ||
              "Você é o Nexus, um assistente útil, honesto e cuidadoso. Responda em português brasileiro. Não invente ações realizadas nem diga que tem acesso a sistemas sem autorização.",
          }],
        },
        contents,
        generationConfig: { temperature: 0.4 },
      }),
    }
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result.error?.message || "Erro no provedor Gemini.";
    throw new Error(`Gemini API (${response.status}): ${detail}`);
  }
  const answer = result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();
  if (!answer) throw new Error("O Gemini retornou uma resposta vazia.");
  return { answer, model };
}

async function chat(request, env) {
  const user = await authenticateUser(request, env);
  if (!user) return json({ error: "Sessão inválida. Entre na sua conta para continuar." }, 401);

  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const userId = user.id;

  if (!message || message.length > 8000) {
    return json({ error: "Envie uma mensagem com até 8.000 caracteres." }, 400);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY || !env.GEMINI_API_KEY) {
    return json({ error: "Configure SUPABASE_SERVICE_ROLE_KEY e GEMINI_API_KEY nos segredos do Worker." }, 503);
  }

  try {
    const history = await getRecentMessages(env, userId);
    const generated = await generateWithGemini(env, history, message);
    await saveMessage(env, userId, "user", message);
    await saveMessage(env, userId, "assistant", generated.answer);
    return json({ answer: generated.answer, model: generated.model });
  } catch (error) {
    return json({ error: "Falha ao processar a conversa.", detail: error.message }, 502);
  }
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nexus 2</title><style>body{font-family:system-ui;background:#0b1220;color:#e8eefc;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}main{max-width:560px;background:#14213a;padding:28px;border-radius:18px}h1{color:#8ab4ff}code{color:#9fe3b0}</style></head><body><main><h1>Nexus 2</h1><p>O serviço está publicado e respondendo.</p><p>Status: <strong>online</strong></p><p>Verificação técnica: <a href="/health" style="color:#8ab4ff">/health</a></p><p>O chat usa a rota <code>POST /v1/chat</code> e precisa de uma sessão autenticada.</p></main></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } }
      );
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "nexus-worker", version: "0.2.0", ai: "gemini" }, 200, headers);
    }
    if (request.method === "POST" && url.pathname === "/v1/chat") {
      return chat(request, env).then((response) => {
        const merged = new Headers(response.headers);
        for (const [key, value] of Object.entries(headers)) merged.set(key, value);
        return new Response(response.body, { status: response.status, headers: merged });
      });
    }
    return json({ error: "Rota não encontrada." }, 404, headers);
  },
};
