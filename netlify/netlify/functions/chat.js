
export default async (req) => {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ erro: "Use POST para conversar." }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  try {
    const { mensagem } = await req.json();

    if (!mensagem || typeof mensagem !== "string") {
      return new Response(
        JSON.stringify({ erro: "Envie uma mensagem." }),
        { status: 400 }
      );
    }

    return new Response(
      JSON.stringify({
        resposta: "Olá! Eu sou sua IA. Recebi sua mensagem: " + mensagem
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch {
    return new Response(
      JSON.stringify({ erro: "Não consegui processar a mensagem." }),
      { status: 500 }
    );
  }
};
