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

async function saveKnowledge(env, userId, title, content) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/nexus_knowledge`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({ user_id: userId, title, content }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Não foi possível salvar o conhecimento (${response.status}): ${detail.slice(0, 250)}`);
  }
}

function extractSearchTerms(text) {
  const normalized = String(text || "")
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[^a-z0-9\\s-]/g, " ");
  const ignored = new Set([
    "qual","quais","quando","onde","como","porque","por que","quem","isso","essa","esse",
    "para","com","uma","umas","uns","dos","das","que","por","mais","menos","sobre",
    "voce","voces","meu","minha","seu","sua","tem","ter","foi","ser","sao","era",
    "the","and","for","with","from","this","that"
  ]);
  return [...new Set(normalized.split(/\\s+/).filter(word => word.length >= 3 && !ignored.has(word)))].slice(0, 7);
}

async function searchKnowledge(env, userId, searchText) {
  if (!searchText) return [];
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };

  const terms = extractSearchTerms(searchText);
  const queries = [searchText, ...terms];
  if (terms.length >= 2) queries.push(terms.slice(0, 2).join(" "));
  const uniqueQueries = [...new Set(queries)].slice(0, 8);

  // Tenta a busca textual do banco com a pergunta e também com palavras-chave.
  const rpcResults = await Promise.all(uniqueQueries.map(async (query) => {
    try {
      const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/search_nexus_knowledge`, {
        method: "POST",
        headers,
        body: JSON.stringify({ search_text: query, owner_id: userId }),
      });
      if (!response.ok) return [];
      const rows = await response.json();
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return [];
    }
  }));

  const merged = new Map();
  for (const row of rpcResults.flat()) {
    if (row && row.id) {
      const old = merged.get(row.id);
      if (!old || Number(row.rank || 0) > Number(old.rank || 0)) merged.set(row.id, row);
    }
  }
  if (merged.size) return [...merged.values()].sort((a, b) => Number(b.rank || 0) - Number(a.rank || 0)).slice(0, 6);

  // Alternativa: procura cada palavra importante diretamente nos títulos e conteúdos.
  if (!terms.length) return [];
  const fallbackUrl = new URL(`${env.SUPABASE_URL}/rest/v1/nexus_knowledge`);
  fallbackUrl.searchParams.set("select", "id,title,content");
  fallbackUrl.searchParams.set("user_id", `eq.${userId}`);
  const clauses = terms.slice(0, 6).flatMap(term => [
    `title.ilike.*${term}*`,
    `content.ilike.*${term}*`
  ]);
  fallbackUrl.searchParams.set("or", `(${clauses.join(",")})`);
  fallbackUrl.searchParams.set("limit", "20");
  const fallback = await fetch(fallbackUrl, { headers });
  if (!fallback.ok) {
    const detail = await fallback.text().catch(() => "");
    throw new Error(`Busca da memória falhou (alternativa ${fallback.status}): ${detail.slice(0, 180)}`);
  }
  const rows = await fallback.json();
  return Array.isArray(rows) ? rows : [];
}

async function knowledgeRoute(request, env) {
  const user = await authenticateUser(request, env);
  if (!user) return json({ error: "Sessão inválida. Entre na sua conta." }, 401);
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Configuração do Supabase incompleta." }, 503);
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!title || !content || title.length > 180 || content.length > 20000) {
      return json({ error: "Informe título e conteúdo. Limites: 180 e 20.000 caracteres." }, 400);
    }
    try {
      await saveKnowledge(env, user.id, title, content);
      return json({ ok: true, message: "Conhecimento salvo na memória do Nexus." }, 201);
    } catch (error) {
      return json({ error: error.message }, 502);
    }
  }

  if (request.method === "GET") {
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") || "").trim().slice(0, 300);
    if (!query) return json({ results: [] });
    try {
      const results = await searchKnowledge(env, user.id, query);
      return json({ results });
    } catch (error) {
      return json({ error: error.message }, 502);
    }
  }
  return json({ error: "Método não permitido." }, 405);
}

function calculateSimpleExpression(input) {
  const expression = input
    .replace(/quanto é|calcule|calcular|resultado de/gi, "")
    .replace(/,/g, ".")
    .trim();
  if (!expression || !/^[0-9+\-*/().\s]+$/.test(expression)) return null;

  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) return null;

  const values = [];
  const operators = [];
  const precedence = { "+": 1, "-": 1, "*": 2, "/": 2 };
  const apply = () => {
    const op = operators.pop();
    const b = values.pop();
    const a = values.pop();
    if (a === undefined || b === undefined) throw new Error("Expressão incompleta.");
    if (op === "+") values.push(a + b);
    if (op === "-") values.push(a - b);
    if (op === "*") values.push(a * b);
    if (op === "/") {
      if (b === 0) throw new Error("Não é possível dividir por zero.");
      values.push(a / b);
    }
  };

  let previous = "operator";
  for (const token of tokens) {
    if (/^\d/.test(token)) {
      if (previous === "number" || previous === ")") return null;
      values.push(Number(token));
      previous = "number";
    } else if (token === "(") {
      if (previous === "number" || previous === ")") return null;
      operators.push(token);
      previous = "(";
    } else if (token === ")") {
      if (previous !== "number" && previous !== ")") return null;
      while (operators.length && operators[operators.length - 1] !== "(") apply();
      if (operators.pop() !== "(") return null;
      previous = ")";
    } else {
      if (previous !== "number" && previous !== ")") {
        if (token === "-" && previous === "operator") {
          values.push(0);
        } else {
          return null;
        }
      }
      while (operators.length && operators[operators.length - 1] !== "(" &&
        precedence[operators[operators.length - 1]] >= precedence[token]) apply();
      operators.push(token);
      previous = "operator";
    }
  }
  if (previous !== "number" && previous !== ")") return null;
  while (operators.length) {
    if (operators[operators.length - 1] === "(") return null;
    apply();
  }
  if (values.length !== 1 || !Number.isFinite(values[0])) return null;
  return Number(values[0].toFixed(8));
}

function buildLocalAgentAnswer(message, knowledge = [], history = []) {
  const text = message.trim();
  const normalized = text.toLocaleLowerCase("pt-BR");

  const calculation = calculateSimpleExpression(text);
  if (calculation !== null && /\\d/.test(text)) {
    return "Fiz o cálculo: " + text + " = " + calculation.toLocaleString("pt-BR") +
      ".\\n\\nEsse cálculo foi executado pelo próprio Nexus, sem Gemini.";
  }

  if (/^(oi|olá|ola|bom dia|boa tarde|boa noite|e aí|eai)[!. ]*$/.test(normalized)) {
    return "Olá! Sou o Nexus. Pode me perguntar sobre as informações que você já guardou na minha memória.";
  }

  if (/quem é você|quem e voce|o que você é|o que voce e|como você funciona|como voce funciona/.test(normalized)) {
    return "Sou o Nexus, um agente independente em desenvolvimento. Consigo guardar informações na sua conta, pesquisar esses registros e fazer cálculos simples. Ainda não tenho raciocínio livre de um modelo de linguagem.";
  }

  if (/o que você sabe fazer|o que voce sabe fazer|suas funções|suas funcoes|ajuda|comandos/.test(normalized)) {
    return "Já consigo guardar informações que você me ensina, pesquisar a memória da sua conta e usar os registros encontrados para responder perguntas relacionadas. Também faço cálculos simples.";
  }

  if (knowledge.length) {
    const terms = extractSearchTerms(text);
    const ranked = knowledge.map((item, index) => {
      const title = String(item.title || item.name || "");
      const content = String(item.content || item.chunk || item.text || item.document || "");
      const haystack = (title + " " + content).toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
      const matches = terms.filter(term => haystack.includes(term)).length;
      return { item, title, content, matches, rank: Number(item.rank || 0), index };
    }).sort((a, b) => b.matches - a.matches || b.rank - a.rank || a.index - b.index);

    const best = ranked[0];
    if (best && best.content) {
      const extra = ranked.slice(1, 3).filter(row => row.content && row.matches > 0);
      const sourceMarker = best.content.indexOf("Fonte: ");
      const publicSource = best.item.sourceUrl || (sourceMarker >= 0
        ? best.content.slice(sourceMarker + 7).split("\\n")[0].trim()
        : "");
      let answer = (publicSource
        ? "Pesquisei uma fonte pública e encontrei estas informações. Também guardei o material na memória do Nexus.\\n\\n"
        : "Encontrei na minha memória uma informação relacionada à sua pergunta.\\n\\n") +
        (best.title ? best.title + "\\n" : "") + best.content.slice(0, 3500) +
        (publicSource ? "\\n\\nFonte: " + publicSource : "");
      if (extra.length) {
        answer += "\\n\\nTambém encontrei estes registros relacionados:\\n" +
          extra.map(row => "• " + (row.title || "Outro registro") + ": " + row.content.slice(0, 700)).join("\\n\\n");
      }
      return answer + (publicSource
        ? "\\n\\nGuardei esta consulta na memória pública do Nexus."
        : "\\n\\nUsei informações que já estavam guardadas na memória do Nexus.");
    }
  }

  return "Ainda não encontrei essa informação na memória que você me ensinou.\\n\\nSe quiser, escreva “Nexus, guarde que...” seguido da informação. Vou salvar na sua base para poder recuperá-la quando você perguntar novamente.";
}

async function searchPublicKnowledge(query) {
  const cleanQuery = String(query || "")
    .replace(/^(?:nexus[, ]*)?(?:pesquise|pesquisar|procure|busque|pesquisa)(?: na internet| na web| sobre)?[: ,.-]*/i, "")
    .trim()
    .slice(0, 180);
  if (cleanQuery.length < 4) return [];

  try {
    const searchUrl = new URL("https://pt.wikipedia.org/w/api.php");
    searchUrl.searchParams.set("action", "query");
    searchUrl.searchParams.set("list", "search");
    searchUrl.searchParams.set("srsearch", cleanQuery);
    searchUrl.searchParams.set("srlimit", "3");
    searchUrl.searchParams.set("srnamespace", "0");
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("utf8", "1");

    const searchResponse = await fetch(searchUrl, {
      headers: { "accept": "application/json", "user-agent": "Nexus2KnowledgeBot/1.0 (personal learning assistant)" }
    });
    if (!searchResponse.ok) return [];
    const searchData = await searchResponse.json();
    const hits = searchData?.query?.search || [];
    if (!hits.length) return [];

    const titles = hits.map(hit => hit.title).filter(Boolean);
    const pageUrl = new URL("https://pt.wikipedia.org/w/api.php");
    pageUrl.searchParams.set("action", "query");
    pageUrl.searchParams.set("prop", "extracts");
    pageUrl.searchParams.set("explaintext", "1");
    pageUrl.searchParams.set("exintro", "1");
    pageUrl.searchParams.set("exchars", "2400");
    pageUrl.searchParams.set("titles", titles.join("|"));
    pageUrl.searchParams.set("format", "json");
    pageUrl.searchParams.set("redirects", "1");

    const pageResponse = await fetch(pageUrl, {
      headers: { "accept": "application/json", "user-agent": "Nexus2KnowledgeBot/1.0 (personal learning assistant)" }
    });
    if (!pageResponse.ok) return [];
    const pageData = await pageResponse.json();
    const pages = Object.values(pageData?.query?.pages || {});
    const consultedAt = new Date().toISOString();

    return pages
      .filter(page => page && page.title && page.extract && page.extract.trim().length > 120)
      .slice(0, 3)
      .map(page => ({
        title: page.title,
        content: page.extract.trim(),
        sourceUrl: "https://pt.wikipedia.org/wiki/" + encodeURIComponent(page.title.replace(/ /g, "_")),
        sourceDate: consultedAt,
        source: "Wikipédia"
      }));
  } catch (_) {
    return [];
  }
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
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "A configuração do Supabase está incompleta." }, 503);
  }

  // Permite ensinar o Nexus diretamente pelo chat, sem abrir o formulário de memória.
  const learningMatch = message.match(/^(?:nexus[, ]*)?(?:guarde|salve|registre|lembre|aprenda)(?: que| isso| na memória| na memoria)?[: ,.-]*(.+)$/i);
  if (learningMatch && learningMatch[1] && learningMatch[1].trim().length >= 5) {
    const learnedText = learningMatch[1].trim();
    const title = learnedText.length > 100 ? learnedText.slice(0, 97) + "..." : learnedText;
    try {
      await saveKnowledge(env, userId, title, learnedText);
      const answer = "Aprendi e guardei essa informação na sua memória do Nexus:\\n\\n" + learnedText +
        "\\n\\nQuando você fizer uma pergunta relacionada, vou procurar esse registro no banco.";
      await saveMessage(env, userId, "user", message).catch(() => null);
      await saveMessage(env, userId, "assistant", answer).catch(() => null);
      return json({ answer, model: "nexus-local-v2", mode: "independent", learned: true });
    } catch (error) {
      return json({ error: "Não consegui guardar a informação.", detail: error.message }, 502);
    }
  }

  // A memória é complementar: se a pesquisa falhar, o agente ainda deve responder.
  let knowledge = [];
  let memoryWarning = null;
  try {
    knowledge = await searchKnowledge(env, userId, message);
  } catch (error) {
    memoryWarning = error.message;
  }

  // Se a memória pessoal não tiver resposta, consulta uma fonte pública gratuita.
  let publicResults = [];
  if (!knowledge.length && !/^(oi|olá|ola|bom dia|boa tarde|boa noite|e aí|eai)[!. ]*$/i.test(message)) {
    publicResults = await searchPublicKnowledge(message);
    for (const item of publicResults) {
      const savedContent = item.content +
        "\\n\\nFonte: " + item.sourceUrl +
        "\\nConsultado em: " + item.sourceDate;
      await saveKnowledge(env, userId, "[Internet] " + item.title, savedContent).catch(() => null);
    }
  }

  try {
    const history = await getRecentMessages(env, userId).catch(() => []);
    const answer = buildLocalAgentAnswer(message, [...knowledge, ...publicResults], history);

    // Falha ao guardar o histórico não deve impedir o envio da resposta.
    await saveMessage(env, userId, "user", message).catch(() => null);
    await saveMessage(env, userId, "assistant", answer).catch(() => null);

    return json({
      answer,
      model: "nexus-local-v2",
      mode: "independent",
      memory_warning: memoryWarning
    });
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
      const page = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b1220">
<title>Nexus 2 — Assistente</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e8eefc;margin:0;min-height:100vh;padding:20px;display:grid;place-items:center}.app{width:100%;max-width:720px;background:#14213a;border:1px solid #263b60;border-radius:22px;overflow:hidden;box-shadow:0 18px 60px #0005}.top{padding:24px;border-bottom:1px solid #263b60}.top h1{margin:0;color:#8ab4ff;font-size:28px}.top p{margin:6px 0 0;color:#aabbd8}.content{padding:22px}.muted{color:#aabbd8;font-size:14px}.tabs{display:flex;gap:8px;margin-bottom:18px}.tabs button,.primary,.secondary{border:0;border-radius:10px;padding:11px 15px;font-weight:650;cursor:pointer}.tabs button{background:#203454;color:#dce8ff}.tabs button.active,.primary{background:#3979db;color:white}.secondary{background:#263b60;color:#e8eefc}.field{display:block;margin:12px 0}.field span{display:block;margin-bottom:6px;font-size:14px;color:#c6d5ed}input,textarea{width:100%;border:1px solid #385276;background:#0e192c;color:white;border-radius:10px;padding:13px;font:inherit}input:focus,textarea:focus{outline:2px solid #3979db;border-color:transparent}.primary{width:100%;margin-top:8px}.notice{min-height:22px;margin:12px 0;color:#ffd28a;font-size:14px}.hidden{display:none!important}.chatlog{height:42vh;min-height:260px;max-height:480px;overflow:auto;background:#0e192c;border:1px solid #263b60;border-radius:14px;padding:14px;margin-bottom:14px}.bubble{padding:11px 13px;border-radius:12px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}.user{background:#244a7d;margin-left:12%}.assistant{background:#1c2c46;margin-right:12%}.composer{display:flex;gap:8px;align-items:flex-end}.composer textarea{resize:vertical;min-height:48px;max-height:140px}.composer button{width:auto;min-width:92px;margin:0}.foot{padding:0 22px 20px;color:#8296b7;font-size:12px}@media(max-width:520px){body{padding:10px}.content{padding:16px}.top{padding:20px}.composer{flex-direction:column}.composer button{width:100%}}
</style>
</head>
<body>
<main class="app">
<header class="top"><h1>Nexus 2</h1><p>Agente experimental independente, com memória própria na sua conta.</p></header>
<section class="content">
<div id="auth">
<div class="tabs"><button id="loginTab" class="active" type="button">Entrar</button><button id="signupTab" type="button">Criar conta</button></div>
<form id="authForm">
<label class="field"><span>E-mail</span><input id="email" type="email" autocomplete="email" required placeholder="voce@exemplo.com"></label>
<label class="field"><span>Senha</span><input id="password" type="password" autocomplete="current-password" minlength="6" required placeholder="Mínimo de 6 caracteres"></label>
<button class="primary" id="authSubmit" type="submit">Entrar</button>
</form>
<p class="muted">Use sua conta do Nexus. Se criar uma conta nova, talvez seja necessário confirmar o e-mail antes de entrar.</p>
</div>
<div id="chatArea" class="hidden">
<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px"><span id="signedIn" class="muted"></span><button id="logout" class="secondary" type="button">Sair</button></div>
<section style="background:#0e192c;border:1px solid #263b60;border-radius:14px;padding:14px;margin-bottom:14px">
<h3 style="margin:0 0 6px;color:#8ab4ff">Memória própria do Nexus</h3>
<p class="muted" style="margin:0 0 10px">Guarde informações para o Nexus pesquisar e usar como contexto nas respostas.</p>
<form id="knowledgeForm">
<label class="field"><span>Título</span><input id="knowledgeTitle" maxlength="180" required placeholder="Ex.: Sobre meu projeto"></label>
<label class="field"><span>Informação para guardar</span><textarea id="knowledgeContent" maxlength="20000" required placeholder="Escreva aqui uma informação, orientação ou conhecimento..."></textarea></label>
<button class="secondary" id="knowledgeSave" type="submit">Guardar na memória</button>
</form>
<p id="knowledgeStatus" class="muted" role="status"></p>
</section>
<div id="chatlog" class="chatlog" aria-live="polite"><p class="muted">Olá! Sou o Nexus. Estou no modo independente. Escreva sua mensagem abaixo.</p></div>
<form id="chatForm" class="composer"><textarea id="message" maxlength="8000" required placeholder="Escreva sua mensagem..."></textarea><button class="primary" id="send" type="submit">Enviar</button></form>
</div>
<p id="notice" class="notice" role="status"></p>
</section>
<footer class="foot">Nexus 2 · Serviço protegido por autenticação</footer>
</main>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
(function(){
  var SUPABASE_URL = "https://oczxndogkbhbafwfvqzv.supabase.co";
  var SUPABASE_KEY = "sb_publishable_omQyqPGGapRhTtUyla59oQ_if8T1TdE";
  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  var mode = "login";
  var auth = document.getElementById("auth");
  var chatArea = document.getElementById("chatArea");
  var notice = document.getElementById("notice");
  var authForm = document.getElementById("authForm");
  var authSubmit = document.getElementById("authSubmit");
  var loginTab = document.getElementById("loginTab");
  var signupTab = document.getElementById("signupTab");
  var chatlog = document.getElementById("chatlog");
  var sendButton = document.getElementById("send");
  var messageBox = document.getElementById("message");
  function say(text){notice.textContent=text||"";}
  function setMode(next){
    mode=next;
    loginTab.classList.toggle("active",mode==="login");
    signupTab.classList.toggle("active",mode==="signup");
    authSubmit.textContent=mode==="login"?"Entrar":"Criar minha conta";
  }
  function addBubble(role,text){
    var item=document.createElement("div");
    item.className="bubble "+role;
    item.textContent=text;
    chatlog.appendChild(item);
    chatlog.scrollTop=chatlog.scrollHeight;
  }
  function showSession(session){
    if(session && session.user){
      auth.classList.add("hidden");
      chatArea.classList.remove("hidden");
      document.getElementById("signedIn").textContent=session.user.email||"Conta conectada";
    }else{
      chatArea.classList.add("hidden");
      auth.classList.remove("hidden");
    }
  }
  loginTab.addEventListener("click",function(){setMode("login");say("");});
  signupTab.addEventListener("click",function(){setMode("signup");say("");});
  authForm.addEventListener("submit",async function(event){
    event.preventDefault();say("");authSubmit.disabled=true;
    var email=document.getElementById("email").value.trim();
    var password=document.getElementById("password").value;
    try{
      if(mode==="signup"){
        var created=await client.auth.signUp({email:email,password:password});
        if(created.error) throw created.error;
        if(!created.data.session){say("Conta criada. Confira seu e-mail para confirmar o cadastro e depois entre.");}
        else{say("Conta criada com sucesso.");}
      }else{
        var logged=await client.auth.signInWithPassword({email:email,password:password});
        if(logged.error) throw logged.error;
        say("");
      }
    }catch(error){say(error.message||"Não foi possível autenticar.");}
    finally{authSubmit.disabled=false;}
  });
  document.getElementById("logout").addEventListener("click",async function(){
    await client.auth.signOut();chatlog.innerHTML='<p class="muted">Você saiu da sua conta.</p>';say("");
  });
  document.getElementById("knowledgeForm").addEventListener("submit",async function(event){
    event.preventDefault();
    var status=document.getElementById("knowledgeStatus");
    var saveButton=document.getElementById("knowledgeSave");
    var current=await client.auth.getSession();
    var session=current.data.session;
    if(!session){say("Sua sessão expirou. Entre novamente.");return;}
    var title=document.getElementById("knowledgeTitle").value.trim();
    var content=document.getElementById("knowledgeContent").value.trim();
    saveButton.disabled=true;status.textContent="Guardando...";
    try{
      var response=await fetch("/v1/knowledge",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+session.access_token},body:JSON.stringify({title:title,content:content})});
      var data=await response.json().catch(function(){return {};});
      if(!response.ok)throw new Error(data.error||"Não foi possível guardar.");
      document.getElementById("knowledgeForm").reset();
      status.textContent="Salvo! O Nexus poderá pesquisar essa informação sem depender do Gemini.";
    }catch(error){status.textContent=error.message||"Erro ao guardar conhecimento.";}
    finally{saveButton.disabled=false;}
  });
  document.getElementById("chatForm").addEventListener("submit",async function(event){
    event.preventDefault();
    var message=messageBox.value.trim();
    if(!message)return;
    var current=await client.auth.getSession();
    var session=current.data.session;
    if(!session){showSession(null);say("Sua sessão expirou. Entre novamente.");return;}
    addBubble("user",message);messageBox.value="";sendButton.disabled=true;sendButton.textContent="Enviando...";say("");
    try{
      var response=await fetch("/v1/chat",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+session.access_token},body:JSON.stringify({message:message})});
      var data=await response.json().catch(function(){return {};});
      if(!response.ok)throw new Error(data.detail||data.error||"Erro ao conversar com o Nexus.");
      addBubble("assistant",data.answer||"Não recebi uma resposta.");
    }catch(error){addBubble("assistant","Não consegui responder: "+(error.message||"erro desconhecido"));}
    finally{sendButton.disabled=false;sendButton.textContent="Enviar";messageBox.focus();}
  });
  client.auth.getSession().then(function(result){showSession(result.data.session);});
  client.auth.onAuthStateChange(function(_event,session){showSession(session);});
})();
</script>
</body>
</html>`;
      return new Response(page, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", ...headers },
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "nexus-worker", version: "0.5.0", ai: "nexus-local-agent-v2" }, 200, headers);
    }
    if ((request.method === "POST" || request.method === "GET") && url.pathname === "/v1/knowledge") {
      return knowledgeRoute(request, env).then((response) => {
        const merged = new Headers(response.headers);
        for (const [key, value] of Object.entries(headers)) merged.set(key, value);
        return new Response(response.body, { status: response.status, headers: merged });
      });
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
