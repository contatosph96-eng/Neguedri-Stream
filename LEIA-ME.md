# Neguedri Streaming

## Instalação

Extraia o ZIP completo. No Mac, abra `Instalador NeguedriStream.app`; no Windows, abra `Instalador-NeguedriStream-Windows.bat`. O instalador apresenta a logo e pergunta se deseja instalar. A opção **Não** encerra o instalador.

## macOS

1. O instalador copia os arquivos para `~/Neguedri-Stream` e coloca `Neguedri Stream.app` na Mesa.
2. Depois da cópia, ele verifica Python/Tkinter e Node/npm no Terminal e abre o app da Mesa.
3. Se o macOS bloquear a primeira abertura, clique com o botão direito no app e escolha **Abrir**.
4. Na primeira execução, informe o Bearer token do SheetDB quando solicitado.

Se o macOS bloquear o arquivo, clique nele com o botão direito e escolha **Abrir**.

## Windows

Abra o instalador `.bat` na pasta extraída. Ele copia o sistema para `C:\Neguedri-Stream`, cria o atalho **Neguedri Stream** na Área de Trabalho e verifica Python/Tkinter e Node/npm. O Windows pedirá autorização para gravar em `C:\`.

## Usuários na planilha

O servidor local busca os usuários da API SheetDB `https://sheetdb.io/api/v1/ds6y8emd7rcda`, na aba `BancodeDados`, ao iniciar. O painel de administrador grava na mesma aba quando cria, bloqueia, desbloqueia, renova ou exclui usuários. O primeiro login de um cliente sem datas também grava `dataInicio` e `dataVencimento` na planilha.

Mantenha na primeira linha os cabeçalhos `id`, `nomeCliente`, `usuario`, `senha`, `telefone`, `dataInicio`, `dataVencimento`, `bloqueado`. Cada `id` precisa ser único; `1` é reservado ao administrador. Em `bloqueado`, use `SIM` ou `NAO`. As datas aceitam `AAAA-MM-DD` ou `DD/MM/AAAA`.

### Configurar o acesso do SheetDB

No painel do SheetDB, abra as configurações desta API, habilite autenticação por Bearer token e permita apenas as operações necessárias: **Read**, **Create**, **Update** e **Delete**. Na primeira abertura do app, cole o token no campo protegido. O token fica no computador, fora desta pasta e fora do ZIP:

- macOS: `~/Library/Application Support/Neguedri-Stream/sheetdb-token.txt`
- Windows: `%APPDATA%\Neguedri-Stream\sheetdb-token.txt`

O app envia o token somente pelo servidor local; ele não aparece no HTML. Não publique nem compartilhe esse token. Se precisar trocá-lo, feche o app, substitua o conteúdo desse arquivo e abra novamente.

## Execução local e dados

O servidor roda na porta `1219` e atende os aparelhos da mesma rede Wi-Fi. O endereço anunciado é sempre `http://neguedri-stream.local:1219/`, independente do nome do Mac ou PC que hospeda o servidor. Mantenha apenas um computador executando o servidor por vez. Se um aparelho não resolver nomes `.local`, use o endereço IP alternativo exibido no iniciador; alguns Android podem exigir esse endereço.

A interface e os arquivos do app já vêm dentro da pasta; a inicialização não busca o HTML no GitHub. Favoritos, histórico, progresso, configuração IPTV e cache de usuários ficam na pasta local de dados do usuário.

Requisitos em Mac e Windows: Python 3.8 ou superior com Tkinter e Node.js 18 ou superior (com npm). Na primeira execução, o app instala o Express e o suporte mDNS localmente e precisa de internet para acessar o SheetDB. O mDNS usa `zeroconf` 0.132.2, compatível com Python 3.8+.

`dados.json` contém a configuração do provedor IPTV. Mantenha o arquivo privado e não o publique em repositórios abertos.

## Atualizar o sistema quando a planilha mudar (Render)

O SheetDB continua como fonte dos dados. Na inicialização, o servidor carrega as guias `Adm` e `BancodeDados`. Para refletir edições feitas diretamente no Google Sheets sem reiniciar o Render, o repositório inclui `integracao-planilha/Code.gs`: ele solicita a atualização imediata da guia editada e executa uma reconciliação diária completa. O script envia somente o nome da guia; o servidor lê os dados com o token privado do SheetDB. Favoritos, histórico e progresso não são alterados por essa sincronização.

### Configuração necessária

1. No Render, adicione a variável privada `SHEETDB_SYNC_WEBHOOK_SECRET` ao serviço. Gere um valor aleatório longo (por exemplo, `openssl rand -hex 32`) e guarde-o. O mesmo valor será usado no Apps Script. Não o coloque no Git nem em células da planilha.
2. Faça o deploy desta versão do servidor no Render.
3. Abra a planilha, acesse **Extensões → Apps Script** e copie `integracao-planilha/Code.gs` para o projeto vinculado.
4. No Apps Script, em **Configurações do projeto → Propriedades do script**, crie:
   - `NEGUEDRI_SYNC_URL`: URL base pública do serviço Render, sem barra no final (por exemplo, `https://seu-servico.onrender.com`).
   - `NEGUEDRI_SYNC_SECRET`: o mesmo valor de `SHEETDB_SYNC_WEBHOOK_SECRET` configurado no Render.
5. Se os nomes das guias forem diferentes, crie também as propriedades opcionais `NEGUEDRI_ADM_SHEET_NAME` e `NEGUEDRI_USERS_SHEET_NAME`, com os nomes configurados no servidor.
6. Execute `instalarTriggersSincronizacao` uma vez e autorize as permissões. Depois execute `sincronizarPlanilhaDiariamente` uma vez para fazer a primeira sincronização.

Edições feitas por pessoas na planilha atualizam a guia correspondente. O gatilho diário busca as duas guias para cobrir alterações que não disparem o evento de edição. Alterações feitas pelo painel do sistema já atualizam o cache após a confirmação do SheetDB.

O endpoint aceita somente as guias configuradas e exige o segredo Bearer. Se houver dados inválidos ou duplicados, a atualização é recusada e o cache anterior é mantido até a correção da planilha. Cada chamada lê uma guia sem usar o cache do SheetDB, para que a alteração manual seja vista imediatamente; a reconciliação diária lê duas. O plano gratuito do SheetDB inclui 500 requisições mensais, e leituras e gravações contam para essa cota.
