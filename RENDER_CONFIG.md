# Configuração do Neguedri Stream no Render

## Runtime
- Node.js 18 ou superior (o projeto usa `fetch` e `Readable.fromWeb`).

## Variáveis de ambiente obrigatórias
Configure no painel do serviço do Render:

- `ADMIN_USER`: nome do usuário administrador (padrão: `Neguedri`).
- `ADMIN_PASS`: defina uma senha administrativa nova e forte. Não reutilize a senha que já esteve no código público.

Após configurar as variáveis, faça um novo deploy.

## Observações
- A branch `correcao-player-render` é separada da branch principal `main`.
- O proxy de mídia reescreve segmentos e URIs em tags HLS para passarem pelo mesmo endpoint.
- A disponibilidade de reprodução também depende dos formatos e codecs fornecidos pelo servidor IPTV e do suporte do navegador.
- O Render em instâncias gratuitas pode usar armazenamento efêmero; arquivos JSON gravados localmente podem não persistir após reinicializações/deploys. Para produção, use armazenamento persistente ou banco de dados.
