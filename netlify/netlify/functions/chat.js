
export default async (req) => {
  const headers = {
    "Content-Type": "application/json"
  };

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ erro: "Use POST para conversar." }),
      { status: 405, headers }
    );
  }

  try {
    const { mensagem } = await req.json();

    if (!mensagem || typeof mensagem !== "string") {
      return new Response(
        JSON.stringify({ erro: "Envie uma mensagem." }),
        { status: 400, headers }
      );
    }

    const apiKey = Netlify.env.get("GEMINI_API_KEY");

    if (!apiKey) {
      return new Response(
        JSON.stringify({ erro: "Chave Gemini não configurada." }),
        { status: 500, headers }
      );
    }

    const resposta = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "Você é Nexus, um assistente de inteligência artificial amigável, inteligente e prestativo. Responda em português do Brasil."
            }]
          },
          contents: [{
            role: "user",
            parts: [{ text: mensagem }]
          }]
        })
      }
    );

    const dados = await resposta.json();

    if (!resposta.ok) {
      return new Response(
        JSON.stringify({
          erro: "O Gemini apresentou um erro.",
          detalhe: dados.error?.message || "Erro na API."
        }),
        { status: resposta.status, headers }
      );
    }

    const texto = dados.candidates?.[0]?.content?.parts
      ?.map(parte => parte.text || "")
      .join("");

    return new Response(
      JSON.stringify({
        resposta: texto || "Não consegui gerar uma resposta."
      }),
      { status: 200, headers }
    );

  } catch (erro) {
    return new Response(
      JSON.stringify({
        erro: "Falha ao conversar com o Nexus."
      }),
      { status: 500, headers }
    );
  }
};
