# Nexus — cérebro inicial

Backend inicial do Nexus para Cloudflare Workers, com memória de conversas no Supabase e respostas por API da OpenAI.

## O que esta versão faz

- `GET /health`: verifica se o Worker está publicado.
- `POST /v1/chat`: recebe uma mensagem autenticada, recupera as últimas 12 mensagens do mesmo usuário, consulta o modelo configurado e grava pergunta e resposta no Supabase.
- Segredos ficam nas configurações do Cloudflare, nunca neste repositório.

> Esta é uma primeira memória de conversa por histórico recente. Ainda não é memória semântica/embeddings, não aprende nem treina o modelo, e não substitui autenticação de usuários no site.

## 1. Banco Supabase

1. Crie um projeto no Supabase.
2. Abra **SQL Editor** e execute o arquivo `schema.sql`.
3. Em **Project Settings → API**, copie a URL do projeto e a chave `service_role`. Nunca coloque a chave `service_role` no site ou em código público.

## 2. Publicar no Cloudflare Workers

1. Abra https://dash.cloudflare.com/ e entre/crie sua conta.
2. Vá em **Workers & Pages** e crie um Worker.
3. Para publicar pelo GitHub, conecte este repositório e escolha a branch `feat/nexus-worker-foundation` (ou use Wrangler localmente).
4. Configure os secrets/variáveis no Worker:
   - `NEXUS_API_KEY`: uma senha longa e aleatória criada por você.
   - `OPENAI_API_KEY`: chave de API do provedor OpenAI.
   - `SUPABASE_URL`: URL do projeto Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY`: chave service_role do Supabase.
   - `OPENAI_MODEL`: opcional; padrão `gpt-4.1-mini`.
   - `NEXUS_SYSTEM_PROMPT`: opcional; instruções de personalidade do Nexus.
   - `ALLOWED_ORIGIN`: opcional; domínio exato do site que chamará o Worker.
5. Publique e teste `https://SEU-WORKER.workers.dev/health`.

## 3. Chamada de chat

Envie um POST para `https://SEU-WORKER.workers.dev/v1/chat` com:

Headers:
- `Authorization: Bearer SUA_NEXUS_API_KEY`
- `Content-Type: application/json`

Body:
```json
{
  "userId": "id-estavel-do-usuario",
  "message": "Olá, Nexus!"
}
```

Resposta:
```json
{ "answer": "Olá! Como posso ajudar?", "model": "gpt-4.1-mini" }
```

O site deve usar um identificador estável por usuário e chamar o Worker. Não exponha a chave `NEXUS_API_KEY`, a chave OpenAI ou a chave service_role no JavaScript público do navegador. Para produção, a autenticação do usuário deve ser validada no servidor, em vez de confiar apenas em um userId enviado pelo navegador.

## Custos e limites

Cloudflare, Supabase e o provedor de IA têm limites e planos próprios. A API de IA pode gerar cobrança separada; confira preços e limites antes de adicionar créditos.

## Próximas etapas

- Conectar o site Nexus a `/v1/chat`.
- Implementar login real e associar cada memória à conta autenticada.
- Adicionar controles para consultar, exportar e apagar memórias.
- Avaliar memória de longo prazo por busca semântica, com consentimento do usuário.
