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

function authorized(request, env) {
  const expected = env.NEXUS_API_KEY;
  if (!expected) return false;
  return request.headers.get("Authorization") === `Bearer ${expected}`;
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

async function chat(request, env) {
  if (!authorized(request, env)) return json({ error: "Não autorizado." }, 401);
  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  if (!message || message.length > 8000 || !userId || userId.length > 120) {
    return json({ error: "Envie userId e uma mensagem (máximo 8.000 caracteres)." }, 400);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.OPENAI_API_KEY) {
    return json({ error: "Configure os secrets e variáveis do Worker antes de usar o chat." }, 503);
  }

  try {
    const history = await getRecentMessages(env, userId);
    await saveMessage(env, userId, "user", message);

    const messages = [
      {
        role: "system",
        content: env.NEXUS_SYSTEM_PROMPT ||
          "Você é o Nexus, um assistente útil, honesto e cuidadoso. Responda em português brasileiro. Não invente ações realizadas nem diga que tem acesso a sistemas sem autorização.",
      },
      ...history,
      { role: "user", content: message },
    ];

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4.1-mini",
        messages,
        temperature: 0.4,
      }),
    });

    const result = await aiResponse.json().catch(() => ({}));
    if (!aiResponse.ok) {
      return json({ error: "O serviço de IA não respondeu corretamente.", detail: result.error?.message || "Erro no provedor." }, 502);
    }
    const answer = result.choices?.[0]?.message?.content;
    if (!answer) return json({ error: "A IA retornou uma resposta vazia." }, 502);
    await saveMessage(env, userId, "assistant", answer);
    return json({ answer, model: env.OPENAI_MODEL || "gpt-4.1-mini" });
  } catch (error) {
    return json({ error: "Falha ao processar a conversa.", detail: error.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "nexus-worker", version: "0.1.0" }, 200, headers);
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
