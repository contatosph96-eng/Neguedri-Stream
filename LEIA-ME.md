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
