---
name: mcp-screenshot
description: Capture e verifique screenshots de janelas do macOS com o mcp-screenshot. Use para prints de aplicativos, recortes visuais, perfis fixos, censura e lotes de abas do Burp Repeater ou itens do Organizer.
---

# MCP Screenshot

Consulte `get_capture_guide` e `get_capture_status` do servidor conectado. Confira permissões, preferências e os parâmetros anunciados pelas ferramentas. Uma sessão aberta pode estar usando uma versão anterior ao build local.

## Escolha da captura

- **Janela inteira.** Identifique a janela em `list_windows(detail="full")` e passe seu `window_id` e `selection_token` (como `expected_window_token`) a `capture_window(persist=true)` para salvar diretamente, sem abrir o seletor. Se várias janelas corresponderem ao pedido, identifique a correta pelo título ou peça que o usuário escolha. Use captura de monitor apenas quando o pedido abranger a tela inteira.
- **Recorte pelo conteúdo**, como “o logo da aba About” ou “o terminal sem o cabeçalho”. Na mesma conexão MCP, obtenha uma prévia com `capture_window(persist=false, include_image=true)`, sem recorte nem perfil. Inspecione a imagem. Abra `select_capture_region` com a mesma janela, o pedido e `suggestion={region,source_sha256,reason}`. Use o hash da prévia e coordenadas relativas à imagem completa, com origem no canto superior esquerdo. Deixe o nome do perfil vazio. Avise que o seletor aguarda confirmação e permita ao usuário ajustar o recorte.
- **Perfil fixo solicitado.** Consulte `list_capture_profiles` e use `capture_window(profile=...)` para a captura direta quando o usuário quiser reutilizar aquele enquadramento. Confira se os painéis ainda cabem no retângulo. Em caso de incompatibilidade, proponha recalibrar. Para criar um perfil, abra o seletor com um nome e deixe o usuário confirmar a região.
- **Censura.** Mesmo com perfil fixo, use o seletor revisado quando houver pedido de censura. Confirme que o servidor conectado oferece censura antes de salvar. Se o recurso estiver indisponível, informe a limitação e mantenha a captura pendente. Inspecione cada prévia e sugira máscaras com `mask_suggestion={source_sha256,masks}`; passe `redact=true` para um pedido explícito. Use coordenadas relativas à prévia inteira e omita os valores sensíveis dos argumentos e metadados. Para segredos, prefira bloco preto com cobertura total. Respeite a escolha de guardar o original. Nos servidores que oferecem essa preferência por perfil, ela controla a cópia adicional; a localização dos dados sensíveis precisa ser revista a cada imagem.

## Navegação e lotes

Quando o MCP do Burp estiver disponível, localize as abas com `list_repeater_tabs` e ative cada uma com `select_repeater_tab(tabId, expectedTitle)`. Para o Organizer, use `select_organizer_item` na coleção pedida. O MCP do Burp é opcional. A interface do aplicativo também permite navegar até o conteúdo existente, sem reenviar requisições.

Use o mesmo `case_id` no lote. Para cada item, alterne a aba, confirme visualmente a identidade na prévia completa e só então capture. Em recortes dinâmicos, recalcule a área útil. Passe IDs anteriores em `reject_same_as`, respeitando o limite anunciado. Se o resultado repetir a imagem ou cortar conteúdo solicitado, identifique a captura afetada e corrija o enquadramento antes de prosseguir.

## Entrega

**Capturar e salvar** grava a prévia congelada aprovada. **Atualizar prévia** exige nova inspeção do conteúdo. **Salvar apenas a seleção** retorna geometria e pode salvar um perfil. Após cancelamento ou timeout, confira o resultado e as evidências antes de repetir.

Quando o seletor retornar `metadata.persisted=true`, reutilize o ID retornado para evitar uma segunda captura. Confirme a persistência, recupere o PNG com `get_evidence(id, include_image=true)` e confira o conteúdo final. Se o limite de tamanho impedir a visualização inline, confira o arquivo local indicado nos metadados. Entregue o caminho retornado pelo servidor e indique itens pendentes em lotes parciais. Em capturas censuradas, vincule o PNG principal indicado nos metadados. Inclua o original em exportações apenas quando solicitado. Se houver descrição, descreva o que aparece no recorte, no idioma do usuário, sem transcrever valores sensíveis.
