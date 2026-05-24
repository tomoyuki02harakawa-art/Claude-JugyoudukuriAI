// ============================================================
//  授業づくりAI - Gemini API 対話パートナー
//  4ステップ対話型エージェント
// ============================================================

// ---------- 教材の読み込みヘルパー ----------
let loadedMaterials = typeof knowledgeData !== 'undefined' ? knowledgeData : {};
let conversationHistory = [];
let isLoading = false;
let apiKey = '';

// ---------- メイン初期化処理 ----------
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded - Initializing...");

    try {
        const getEl = (id) => document.getElementById(id);

        // --- 1. 設定モーダル関連（最優先） ---
        const settingsBtn = getEl('settings-btn');
        const settingsModal = getEl('settings-modal');
        const apiKeyInput = getEl('api-key-input');
        const apiKeySaveBtn = getEl('api-key-save-btn');
        const apiKeyStatus = getEl('api-key-status');
        const closeModalBtn = document.querySelector('.modal .close-button');

        if (settingsBtn) {
            settingsBtn.addEventListener('click', (e) => {
                console.log("Settings button clicked!");
                e.preventDefault(); // リロード防止
                if (settingsModal) {
                    settingsModal.classList.add('show');
                    if (apiKeyInput) apiKeyInput.value = apiKey || "";
                    if (apiKeyStatus) apiKeyStatus.textContent = '';
                }
            });
        }

        if (closeModalBtn && settingsModal) {
            closeModalBtn.addEventListener('click', (e) => {
                e.preventDefault();
                settingsModal.classList.remove('show');
            });
        }
        window.addEventListener('click', (e) => {
            if (settingsModal && e.target === settingsModal) settingsModal.classList.remove('show');
        });

        if (apiKeySaveBtn) {
            apiKeySaveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const val = apiKeyInput ? apiKeyInput.value.trim() : '';
                const match = val.match(/(sk-ant-[A-Za-z0-9_\-]+)/);
                if (match) {
                    apiKey = match[1];
                    localStorage.setItem('claude_api_key', apiKey);
                    if (apiKeyStatus) {
                        apiKeyStatus.textContent = "✅ 保存完了";
                        apiKeyStatus.className = "api-key-status success";
                    }
                    setTimeout(() => { if (settingsModal) settingsModal.classList.remove('show'); }, 800);
                } else {
                    if (apiKeyStatus) {
                        apiKeyStatus.textContent = "❌ 無効な形式";
                        apiKeyStatus.className = "api-key-status error";
                    }
                }
            });
        }

        // --- 2. フォーム & チャット関連 ---
        const form = getEl('lesson-form');
        const questionnaireSection = getEl('questionnaire-section');
        const resultsSection = getEl('results-section');
        const chatContainer = getEl('chat-container');
        const chatMessages = getEl('chat-messages');
        const chatTextarea = getEl('chat-textarea');
        const sendBtn = getEl('send-btn');
        const restartBtn = getEl('restart-btn');
        const loadingIndicator = getEl('loading-indicator');
        const apiKeyWarning = getEl('api-key-warning');
        const errorMessageDisplay = getEl('error-message-display');

        if (form) {
            form.addEventListener('submit', (e) => {
                console.log('Submit trigger detected via Listener');
                e.preventDefault(); // デフォルト送信を阻止
                handleFormSubmit(e);
            });
        }

        if (sendBtn) sendBtn.addEventListener('click', (e) => {
            e.preventDefault();
            sendUserMessage();
        });
        if (chatTextarea) {
            chatTextarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendUserMessage();
                }
            });
        }
        if (restartBtn) {
            restartBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (confirm('最初からやり直しますか？')) location.reload();
            });
        }

        // --- 3. 引用ソースビューアー ---
        const sidePanel = getEl('side-panel');
        const sideContent = getEl('side-panel-content');
        const sideFilename = getEl('side-panel-filename');
        const closeSideBtn = getEl('close-side-panel');

        if (closeSideBtn) {
            closeSideBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (sidePanel) sidePanel.classList.remove('show');
                document.querySelector('.main-wrapper').classList.remove('panel-open');
            });
        }

        if (chatMessages) {
            chatMessages.addEventListener('click', (e) => {
                const link = e.target.closest('.source-link');
                if (link) {
                    const fileName = link.getAttribute('data-file');
                    // data-cited 属性を優先して引用テキストを取得
                    // なければ隣接する citation-block を探す（後方互換）
                    let citedText = link.getAttribute('data-cited') || '';
                    if (!citedText) {
                        let prevEl = link.previousElementSibling;
                        while (prevEl && prevEl.tagName === 'BR') { prevEl = prevEl.previousElementSibling; }
                        if (prevEl && prevEl.classList.contains('citation-block')) {
                            citedText = prevEl.getAttribute('data-text') || '';
                        }
                    }
                    if (!citedText) {
                        let nextEl = link.nextElementSibling;
                        while (nextEl && nextEl.tagName === 'BR') { nextEl = nextEl.nextElementSibling; }
                        if (nextEl && nextEl.classList.contains('citation-block')) {
                            citedText = nextEl.getAttribute('data-text') || '';
                        }
                    }
                    openSourceViewer(fileName, citedText);
                }
            });
        }

        // --- 内部ヘルパー関数定義 ---
        function format(text) {
            console.log("Formatting started...");
            try {
                if (!text) return '';

                const lines = text.split('\n');
                const processedLines = lines.map(line => {

                    // ██ Step A: 【引用：ファイル名｜引用文】を探し出して抽出 ██
                    // 形式: 【引用：ファイル名｜引用文】
                    // パイプ区切りで「ファイル名」と「引用文」を一方向取得する
                    // AIが【引用：【引用元】ファイル名｜引用文】と出力するケースに対応
                    // ｜の手前までをファイル名として取得し、【引用元】プレフィックスを除去する
                    const citationPattern = /【引用：((?:【[^】]*】)?[^｜】]*)(?:｜([^】]*))?】/g;
                    let citationMatches = [];
                    let cm;
                    while ((cm = citationPattern.exec(line)) !== null) {
                        const rawFileName = (cm[1] || '').trim();
                        citationMatches.push({
                            full: cm[0],
                            fileName: rawFileName.replace(/^【引用元】/, '').trim(),
                            citedText: (cm[2] || '').trim()
                        });
                    }

                    // 【引用：...】をすべて除去してクリーンな本文を残す
                    let cleanLine = line.replace(/【引用：[^】]+】/g, '').trimEnd();

                    // ██ Step B: HTML特殊文字エスケープ ██
                    let escaped = cleanLine
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;');

                    // ██ Step C: インライン装飾（太字・ラベル） ██
                    let decorated = escaped
                        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                        .replace(/【(.+?)】/g, '<span class="citation-label">【$1】</span>');

                    // ██ Step D: 引用本文を citation-block 化 ██
                    // [教科] [段階] [目標] [内容] 形式を読解して data-text に保存
                    const structMatch = cleanLine.match(/^\[.+?\]\s*\[.+?\]\s*\[.+?\]\s*(?:\[(.+?)\]|(.+))$/);
                    let structCitedText = '';
                    if (structMatch) {
                        structCitedText = (structMatch[1] || structMatch[2] || '').trim();
                    }

                    // ██ Step E: ボタンHTML生成 ██
                    // data-file には正確なファイル名、data-cited には引用文を直接埋め込む
                    let buttons = citationMatches.map(c => {
                        // 引用文: パイプ後の文 > 構造マッチ文 の優先順
                        const effectiveCited = c.citedText || structCitedText;
                        const safeFile = c.fileName.replace(/"/g, '&quot;');
                        const safeCited = effectiveCited.replace(/"/g, '&quot;');
                        return `<button class="source-link" data-file="${safeFile}" data-cited="${safeCited}" title="出典を確認">📄 根拠を確認</button>`
                    }).join(' ');

                    // ██ Step F: citation-block でラップ ██
                    const blockCited = (citationMatches[0]?.citedText || structCitedText);
                    if (blockCited) {
                        return `<span class="citation-block" data-text="${blockCited}">${decorated}</span>${buttons ? ' ' + buttons : ''}`;
                    }

                    return decorated + (buttons ? ' ' + buttons : '');
                });

                const result = processedLines.join('<br>');
                console.log("Formatting complete.");
                return result;
            } catch (e) {
                console.error("Formatting Error:", e);
                return `<div class="error-text">表示整形エラー: ${e.message}</div>` + text;
            }
        }

        function openSourceViewer(fileName, citedText) {
            console.log("[openSourceViewer] file:", fileName, "| cited:", citedText);
            if (!sidePanel || !sideContent) return;

            // ██ ファイル解決ロジック（最長一致・ゼロ曖昧） ██
            let content = null;
            let resolvedName = fileName;

            // 1. HTMLエンティティを戻してクリーンなファイル名にする
            //    AIが【引用元】プレフィックス付きで出力した場合も除去する
            const cleanFileName = fileName
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/^【引用元】/, '')   // 先頭の【引用元】を除去
                .trim();

            // 2. 完全一致チェック（最優先）
            if (loadedMaterials[cleanFileName]) {
                content = loadedMaterials[cleanFileName];
                resolvedName = cleanFileName;
                console.log("[openSourceViewer] 完全一致:", resolvedName);
            }

            // 2b. knowledge_data.js のキーが【引用元】プレフィックス付きで登録されている場合に対応
            //     AIはプレフィックスなしで出力するが、実キーは「【引用元】各教科目標と内容txt/...」の形式
            if (!content) {
                const prefixedName = '【引用元】' + cleanFileName;
                if (loadedMaterials[prefixedName]) {
                    content = loadedMaterials[prefixedName];
                    resolvedName = prefixedName;
                    console.log("[openSourceViewer] 【引用元】プレフィックス付き一致:", resolvedName);
                }
            }

            // 3. 完全一致が失敗した場合のみ、basename（拡張子あり）での完全一致
            if (!content) {
                const baseName = cleanFileName.split('/').pop().replace(/\\/g, '/');
                const allKeys = Object.keys(loadedMaterials);
                const exactBase = allKeys.find(k => k.split('/').pop() === baseName);
                if (exactBase) {
                    content = loadedMaterials[exactBase];
                    resolvedName = exactBase;
                console.log("[openSourceViewer] basename完全一致:", resolvedName);
                }
            }

            // 4. 最終手段: 拡張子なしbasename完全一致（曖昧にくいよう1件のみ許容）
            if (!content) {
                const pureBase = cleanFileName.split('/').pop().replace(/\.[^/.]+$/, '').trim();
                const allKeys = Object.keys(loadedMaterials);
                const pureMatches = allKeys.filter(k => {
                    const kPure = k.split('/').pop().replace(/\.[^/.]+$/, '').trim();
                    return kPure === pureBase; // 完全一致のみ
                });
                if (pureMatches.length === 1) {
                    content = loadedMaterials[pureMatches[0]];
                    resolvedName = pureMatches[0];
                    console.log("[openSourceViewer] 拡張子なし完全一致:", resolvedName);
                }
            }

            if (!content) {
                console.warn("[openSourceViewer] ファイル未発見:", fileName, "loadedMaterialsキー:", Object.keys(loadedMaterials));
                alert(`参照ファイル「${cleanFileName}」が見つかりません。\nライブラリに正しく読み込まれているか確認してください。`);
                return;
            }

            // パネルを開く
            sideFilename.textContent = resolvedName.split('/').pop();
            sidePanel.classList.add('show');
            document.querySelector('.main-wrapper').classList.add('panel-open');

            // ██ ハイライトロジック ██
            if (!citedText || citedText.trim() === '') {
                sideContent.innerHTML = `<pre style="white-space:pre-wrap;">${escapeHtml(content)}</pre>`;
                return;
            }

            // ██ 引用文クリーンアップ ██
            // AIが出力する構造ラベルを多パターンで除去して、ファイル本文と一致しやすくする
            let cleanTarget = citedText
                // パターン1: [教科][段階][目標] 形式
                .replace(/^\[.+?\]\s*\[.+?\]\s*\[.+?\]\s*/, "")
                // パターン2: (1) 目 標 / (2) 内 容 などの見出しプレフィックス
                .replace(/^\(\d+\)\s*[目内容標]+(\s*[ア-ン]\s*\S+\s*)?/, "")
                // パターン3: (7) や (ｱ) のようにAIが独自に振った番号プレフィックス
                .replace(/^\([0-9０-９ｦ-ﾝァ-ンア-ン]+\)\s*/, "")
                // パターン4: 「キ 手伝い・仕事」のような項目名プレフィックス（ア〜ン＋スペース＋語句）
                .replace(/^[ア-ン]\s+[\S]+[\s・]+/, "")
                // パターン5: 「ア 」「イ 」のような先頭の片仮名1文字＋スペース（項目記号）
                .replace(/^[ア-ン]\s+/, "")
                // パターン6: 残った先頭のスペース・記号
                .trim();

            console.log("[openSourceViewer] ハイライト対象:", cleanTarget);

            let highlightedHtml = '';
            let found = false;

            // ハイライト範囲を構築するヘルパー（開始位置・長さを受け取りHTML生成）
            function buildHighlight(idx, len, cssClass) {
                const before = escapeHtml(content.substring(0, idx));
                const match  = escapeHtml(content.substring(idx, idx + len));
                const after  = escapeHtml(content.substring(idx + len));
                return `<pre style="white-space:pre-wrap;">${before}<mark class="${cssClass}" id="citation-anchor">${match}</mark>${after}</pre>`;
            }

            // Step 1: 完全一致検索
            const strictIdx = content.indexOf(cleanTarget);
            if (strictIdx !== -1) {
                highlightedHtml = buildHighlight(strictIdx, cleanTarget.length, 'highlight-strict');
                found = true;
                console.log("[openSourceViewer] 完全一致ハイライト成功");
            }

            // Step 2: 空白正規化マッチ（改行・全角スペースの揺れを吸収）
            if (!found) {
                try {
                    const escaped = cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const pattern = escaped.split(/\s+/).join('[\\s\\u3000]+');
                    const regex = new RegExp(pattern);
                    const m = regex.exec(content);
                    if (m) {
                        highlightedHtml = buildHighlight(m.index, m[0].length, 'highlight-relaxed');
                        found = true;
                        console.log("[openSourceViewer] 空白正規化マッチ成功");
                    }
                } catch(e) { console.error("regex error:", e); }
            }

            // Step 3: スライディングウィンドウ（先頭から短縮しながら検索。ヒット後は引用文の長さ分だけ選択）
            // MIN_WINを20字に引き上げて誤ヒットを防ぐ
            if (!found) {
                const MIN_WIN = 20;
                let win = cleanTarget.substring(0, Math.min(50, cleanTarget.length)).trim();
                while (win.length >= MIN_WIN) {
                    const wi = content.indexOf(win);
                    if (wi !== -1) {
                        // ヒット開始位置から引用文の長さ分、ただしファイル末尾を超えない
                        const selLen = Math.min(cleanTarget.length, content.length - wi);
                        highlightedHtml = buildHighlight(wi, selLen, 'highlight-relaxed');
                        found = true;
                        console.log('[openSourceViewer] スライドウィンドウ一致:', win);
                        break;
                    }
                    win = win.substring(0, win.length - 4).trim();
                }
            }

            // Step 4: 意味論的トークン一致（長いフレーズから順に検索。8字→12字に引き上げ）
            if (!found) {
                const tokens = cleanTarget
                    .split(/[、。，．\s]+/)
                    .filter(t => t.length >= 12);
                tokens.sort((a, b) => b.length - a.length);
                for (const tok of tokens) {
                    const ti = content.indexOf(tok);
                    if (ti !== -1) {
                        const selLen = Math.min(cleanTarget.length, content.length - ti);
                        highlightedHtml = buildHighlight(ti, selLen, 'highlight-relaxed');
                        found = true;
                        console.log('[openSourceViewer] トークン一致:', tok);
                        break;
                    }
                }
            }

            if (!found) {
                highlightedHtml = `<div style="color:#e74c3c;padding:8px;background:#ffebee;border-radius:4px;margin-bottom:8px;">❌ 引用箇所を自動特定できませんでした。AIが引用文を要約した可能性があります。ファイル全文を表示します。</div><pre style="white-space:pre-wrap;">${escapeHtml(content)}</pre>`;
                console.warn('[openSourceViewer] ハイライト失敗（全 Step 失敗）');
            }

            sideContent.innerHTML = highlightedHtml;

            // 対象ハイライト箇所まで自動スクロール
            if (found) {
                setTimeout(() => {
                    const anchor = document.getElementById('citation-anchor');
                    if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            }
        }

        async function handleFormSubmit(event) {
            if (event) event.preventDefault(); // フォーム送信デフォルト動作を阻止
            console.log("handleFormSubmit execution started");

            if (!apiKey) {
                alert("APIキーを設定してください");
                return;
            }
            const formData = new FormData(form);
            const rawStage = formData.get('student_stage') || "";
            const concernsText = formData.get('concerns') || "";
            const theme = formData.get('theme') || "";
            const year = formData.get('student_year') || "";

            if (!year || !rawStage || !theme || !concernsText) {
                alert("全項目を入力してください");
                return;
            }

            console.log("Preparing UI for Chat Transition...");

            // ██ Gemini風UI: ヘッダー縮小 & チャットエリア最大化 ██
            const mainHeader = document.querySelector('.main-header');
            if (mainHeader) mainHeader.classList.add('minimized');
            const appContainer = document.querySelector('.app-container');
            if (appContainer) appContainer.classList.add('chat-active');

            if (questionnaireSection) questionnaireSection.classList.add('hidden');
            if (resultsSection) {
                console.log("Target container (resultsSection):", resultsSection);
                resultsSection.classList.remove('hidden');
                resultsSection.style.setProperty('display', 'flex', 'important');
                resultsSection.style.flexDirection = 'column';
                resultsSection.style.flex = '1 1 0';
                resultsSection.style.overflow = 'hidden';
            }
            if (chatContainer) {
                console.log("Target container (chatContainer):", chatContainer);
                chatContainer.classList.remove('hidden');
                chatContainer.classList.add('expanded');
                chatContainer.style.setProperty('display', 'flex', 'important');
                chatContainer.style.flex = '1 1 0';
            }
            
            printAI('対話を開始します。情報を準備中です...');

            // バックグラウンドロードは app_server.py が一括で行うため不要になりました
            
            isLoading = true;
            updateUI();
            
            conversationHistory = [{ role: 'user', parts: [{ text: `学年：${year}\n発達段階：${rawStage}\nテーマ：${theme}\n悩み・現状：${concernsText}\n\n上記の状況について疑問があります。まず入力内容を確認・整理した上で、次に「何を深掘りしたいか」をメニュー形式で提示してください。最初からすべての回答や提案を出す必要はありません。` }] }];
            try {
                console.log("Starting Chat Hub Flow...");
                const reply = await callClaudeAPI(conversationHistory);
                console.log("AI Response Received:", reply);
                conversationHistory.push({ role: 'model', parts: [{ text: reply }] });
                printAI(reply);
            } catch (err) { 
                console.error("Form Submit Error:", err);
                printError(err.message); 
            }
            finally { isLoading = false; updateUI(); }
        }

        async function sendUserMessage() {
            const text = chatTextarea.value.trim();
            if (!text || isLoading) return;
            chatTextarea.value = '';
            printUser(text);
            isLoading = true; 
            updateUI();
            
            conversationHistory.push({ role: 'user', parts: [{ text: text }] });
            try {
                console.log("Sending message to API.");
                const reply = await callClaudeAPI(conversationHistory);
                console.log("AI Response Received:", reply);
                conversationHistory.push({ role: 'model', parts: [{ text: reply }] });
                printAI(reply);
            } catch (err) { 
                console.error("Chat Error:", err);
                printError(err.message); 
            }
            finally { isLoading = false; updateUI(); }
        }

        function updateUI() {
            if (loadingIndicator) isLoading ? loadingIndicator.classList.remove('hidden') : loadingIndicator.classList.add('hidden');
            if (sendBtn) {
                sendBtn.disabled = isLoading;
                sendBtn.textContent = isLoading ? '処理中...' : '送信';
            }
        }

        function printAI(t) {
            console.log("Rendering AI response...");
            try {
                if (!chatMessages) throw new Error("chatMessages element (#chat-messages) not found in DOM.");
                console.log("Target container (chatMessages):", chatMessages);

                const htmlContent = format(t);
                if (!htmlContent) {
                    console.error("Warning: Formatting resulted in empty content.");
                    throw new Error("フォーマット結果が空です。");
                }

                console.log("Writing to DOM: ", htmlContent.substring(0, 100) + "...");
                const d = document.createElement("div"); 
                d.className = "message ai slide-up"; 
                d.innerHTML = htmlContent;
                chatMessages.appendChild(d); 
                chatMessages.scrollTop = chatMessages.scrollHeight;
                console.log("Rendering complete.");
            } catch (e) {
                console.error("Rendering Error:", e);
                const errDiv = document.createElement("div");
                errDiv.className = "message ai error";
                errDiv.innerHTML = `❌ 表示エラー: ${e.message}<br><small>生データ: ${escapeHtml(t).substring(0, 100)}...</small>`;
                if (chatMessages) chatMessages.appendChild(errDiv);
            }
        }
        function printUser(t) {
            const d = document.createElement("div"); d.className = "message user slide-up"; d.textContent = t;
            chatMessages.appendChild(d); chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        function printError(m) {
            const d = document.createElement("div"); d.className = "message ai error"; d.innerHTML = `❌ エラー: ${m}`;
            chatMessages.appendChild(d); chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

        // 初期ロード
        const savedKey = localStorage.getItem('claude_api_key');
        if (savedKey) { apiKey = savedKey; if (apiKeyWarning) apiKeyWarning.classList.add('hidden'); }
        
    } catch (e) {
        console.error("Init error:", e);
    }
});
// --- RAG-lite: 関連コンテキストの絞り込み抽出 ---
// 改修方針：全件送信（コスト大）→ 学部・段階・テーマで絞り込んで必要ファイルのみ送信
//
// 【絞り込みロジック】
// 1. 学部（小学部/中学部/高等部）でまずフィルタ
//    ※特別支援の「名前と中身の分離ルール」に基づき、
//    　発達段階が下位の場合は下位学部のファイルも追加する
// 2. 自立活動は常時含める（どの学部・段階でも関連する可能性が高いため）
// 3. テーマキーワードで教科をさらに絞り込む（国語・算数・音楽等）
//
// 【期待効果】
// 全件送信：約30,000〜50,000トークン → 絞り込み後：約3,000〜8,000トークン（約1/6〜1/10）

function extractRelevantContext(stage, theme) {
    if (typeof knowledgeData === 'undefined') return '';

    const allKeys = Object.keys(knowledgeData);

    // ── 1. 学部の特定 ──────────────────────────────────────────
    // stage は "小学部1段階" "中学部2段階" "高等部3段階" 等の文字列を想定
    // （フォームの student_stage フィールドから渡される値）
    const isElementary = /小学部/.test(stage);
    const isJunior     = /中学部/.test(stage);
    const isSenior     = /高等部/.test(stage);

    // 発達段階が低い場合、下位学部のファイルも必要
    // （高等部在籍でも小学部段階の内容を使う場合 = 特別支援の重複指導の考え方）
    const stageNum = parseInt((stage.match(/([1-3])段階/) || [])[1] || '2', 10);

    // 含めるべき学部プレフィックスを決定
    const includedPrefixes = new Set();
    if (isElementary)                          { includedPrefixes.add('小学部'); }
    if (isJunior)                              { includedPrefixes.add('中学部'); }
    if (isSenior)                              { includedPrefixes.add('高等部'); }

    // 高等部/中学部で発達段階が低い場合、下位学部も追加
    if (isSenior  && stageNum <= 2)            { includedPrefixes.add('中学部'); }
    if (isSenior  && stageNum === 1)           { includedPrefixes.add('小学部'); }
    if (isJunior  && stageNum === 1)           { includedPrefixes.add('小学部'); }

    // 学部が特定できない場合（初回フォーム送信前など）は全件返す
    if (includedPrefixes.size === 0) {
        const results = [];
        for (const [filename, content] of Object.entries(knowledgeData)) {
            results.push(`=== ${filename} ===\n${content}`);
        }
        return results.join('\n\n');
    }

    // ── 2. テーマキーワードで教科を絞り込む ───────────────────
    // テーマ・悩みテキストから教科名キーワードを検出し、
    // 関連する教科ファイルだけを優先的に含める
    const subjectKeywords = {
        '国語':     ['国語', '読み', '書き', '言語', '文字', 'ひらがな', 'カタカナ', '文章', '読書', '話す', '聞く'],
        '算数':     ['算数', '数学', '数', '計算', '足し算', '引き算', '形', '量', '時計', '時間'],
        '音楽':     ['音楽', '歌', 'リズム', '楽器', '合唱', '演奏'],
        '図画工作': ['図画工作', '美術', '工作', '絵', '描く', '作る', '造形'],
        '体育':     ['体育', '保健体育', '運動', '走る', '跳ぶ', '球技', 'スポーツ', '水泳'],
        '生活科':   ['生活', '日常', '家庭', '掃除', '料理', '買い物', '着替え'],
        '職業':     ['職業', '作業', '仕事', '働く', '職場'],
        '家庭':     ['家庭', '調理', '裁縫', '被服', '食事'],
        '理科':     ['理科', '科学', '自然', '植物', '動物', '実験'],
        '社会':     ['社会', '地理', '歴史', '公民', '地域', 'まち'],
        '外国語':   ['外国語', '英語', 'English', 'アルファベット'],
        '情報':     ['情報', 'パソコン', 'タブレット', 'ICT', 'コンピュータ'],
        '自立活動': ['自立活動', '自立', 'コミュニケーション', '身体', '感覚', '姿勢', '移動',
                     '健康', '心理', '人間関係', '環境', '肢体', '視覚', '聴覚', '言語'],
    };

    // テーマ文字列から関連教科を検出
    const themeText = (theme || '') + ' ' + (stage || '');
    const matchedSubjects = new Set();
    for (const [subject, keywords] of Object.entries(subjectKeywords)) {
        if (keywords.some(kw => themeText.includes(kw))) {
            matchedSubjects.add(subject);
        }
    }

    // ── 3. ファイルを絞り込んで収集 ────────────────────────────
    const selectedFiles = [];

    for (const key of allKeys) {
        const filename = key.split('/').pop().replace('.txt', '');

        // 自立活動は常時含める
        if (key.includes('自立活動') || key.includes('自立txt')) {
            selectedFiles.push(key);
            continue;
        }

        // 教科ファイル（各教科目標と内容txt/）の絞り込み
        if (key.startsWith('各教科目標と内容txt/')) {
            // 学部フィルタ
            const matchesPart = [...includedPrefixes].some(p => filename.startsWith(p));
            if (!matchesPart) continue;

            // テーマキーワードがある場合はさらに絞る、ない場合は学部一致ファイル全部含める
            if (matchedSubjects.size > 0) {
                const matchesSubject = [...matchedSubjects].some(s => filename.includes(s));
                // 合わせた指導系（生活科・職業・家庭）は常に含める（授業づくりで頻出）
                const isCoreSubject = ['生活科', '職業', '家庭', '職業・家庭'].some(s => filename.includes(s));
                if (!matchesSubject && !isCoreSubject) continue;
            }

            selectedFiles.push(key);
        }

        // 詳細txtフォルダ（自立活動の詳細）は上のauto-includeで対応済み
    }

    // ── 4. 結果を組み立てて返す ────────────────────────────────
    if (selectedFiles.length === 0) {
        // フォールバック：学部一致ファイル全部
        for (const key of allKeys) {
            const filename = key.split('/').pop();
            const matchesPart = [...includedPrefixes].some(p => filename.startsWith(p));
            if (matchesPart || key.includes('自立活動')) {
                selectedFiles.push(key);
            }
        }
    }

    // デバッグログ（本番では console.log を消してもよい）
    console.log(`[RAG] stage="${stage}" theme="${theme}" → ${selectedFiles.length}件選択:`, selectedFiles);

    const results = [];
    for (const key of selectedFiles) {
        results.push(`=== ${key} ===\n${knowledgeData[key]}`);
    }
    return results.join('\n\n');
}

async function callClaudeAPI(messages) {
    const url = `https://api.anthropic.com/v1/messages`;

    // フォーム入力値（最初のユーザーメッセージ）から学部・テーマを抽出してRAGに渡す
    // 会話が進んでも最初の文脈を維持するため messages[0] を参照する
    let ragStage = '';
    let ragTheme  = '';
    if (messages.length > 0 && messages[0].parts && messages[0].parts[0]) {
        const firstMsg = messages[0].parts[0].text || '';
        const stageMatch = firstMsg.match(/発達段階[：:]\s*([^\n]+)/);
        const themeMatch  = firstMsg.match(/テーマ[：:]\s*([^\n]+)/);
        if (stageMatch) ragStage = stageMatch[1].trim();
        if (themeMatch)  ragTheme  = themeMatch[1].trim();
    }

    const materialsContext = extractRelevantContext(ragStage, ragTheme);

    const systemInstruction = `あなたは「寡黙だが温かいレジェンド先生」だ。
長い経験を積んだ特別支援教育の匠。言葉は少なく荒削りだが、その一言一言に深い愛情と知恵が宿っている。
答えを与えるのではなく、先生自身が気づけるよう、静かに伴走する。

【口調・キャラクターのルール】
- 語尾は「〜だな」「〜だろ」「〜してみようか」「そうか」「なるほどな」など、職人らしい簡潔な言葉を使う。
- 「選んでみろ」は使わない。「選んでみたらどうだ」「どれから行ってみようか」など、相手のペースを尊重する柔らかさを保つ。
- 長々と説明しない。短く、核心だけを突く。
- 「素晴らしいですね」「おっしゃる通りです」などの過剰な共感・敬語・褒め言葉は一切使わない。
- 絵文字・箇条書きの乱用・太字の多用はしない。必要なときだけ使う。
- 冒頭で自己紹介や職人気質の前置きは不要。本質から静かに入れ。
- 情報が不足していると感じたら、勝手に答えを出すな。例を挙げながら逆質問せよ。
  例：「その子、どんな時に一番生き生きしてる？たとえば、手を動かすとき？誰かと関わるとき？」

【伴走型の応答ルール（最重要）】
- 先生の思考が「広がる」「深まる」ことがこのアプリの使命だ。
- 先回りして答えを全部出すな。「次に何を考えるか」の入口だけ示せ。
- 選択肢を出すときは番号リストで4個＋必ず最後に「5. それ以外（自由に書いてくれ）」を加える。
- 回答の締めくくりには、一言だけ、ぶっきらぼうだが温かいねぎらいの言葉を添える。
  例：「悩むのは悪いことじゃないぞ。」「少し、進んだようだな。」「そうやって考えること自体が、その子への力になる。」
- 【余白のルール】俺の話で何か引っかかったなら、続きはここじゃなくていい。
  自分で調べてもいいし、周りの先生と話してみてもいい。自由に書いて送ってくれてもいい。
  俺はその入口になれればそれでいい。そういう一言を、自然な流れで末尾に添えろ。
  ただし毎回同じ文言を貼り付けるな。状況に合った言葉で、短く。

【教科の「名前」と「中身」の完全分離ルール（最重要・必ず守れ）】
教育課程の根本原則として、以下を厳守せよ。

1. 教科の「名前」＝在籍学部で決まる（変えられない）
   - 小学部在籍 → 「生活科」
   - 中学部在籍 → 「職業・家庭」
   - 高等部在籍 → 「職業」「家庭」「情報」等
   ※ 高等部在籍の生徒に「生活科」と呼ぶのは教育課程編成上、不適切。絶対に使うな。

2. 教科の「中身（目標・内容）」＝発達段階で決まる（柔軟に替えられる）
   - 学習指導要領の重複障害者等への特例により、在籍学部より下位の段階の
     目標・内容に替えて指導することが認められている。
   - 例：高等部在籍・発達が小学部3段階 → 名前は「職業」、中身は「生活科（小学部3段階）」

3. 【絶対厳守】「中身」を示すときは、自分で解釈・要約・読み替えをするな。
   必ず下学部・下段階の学習指導要領の記述を、一言一句そのまま根拠として引用せよ。
   - 引用対象は「1 目 標」ではなく「2 各段階の目標及び内容」以降の内容。
   - 段階（１段階〜３段階）、「（１）目標」および関連する「（２）内容」を原文のまま引用する。
   - 「〜に当てはめると」「〜と言えるだろう」のような独自解釈は添えない。
     先生自身が原文から気づけるよう、引用だけを置いて静かに待て。

4. この情報は先生から質問された場合、または文脈上明らかに必要なときのみ答える。
   毎回冒頭に書き出すな。それは先生の思考を邪魔する。

【合わせた指導と各教科との関連づけルール】
「合わせた指導」（日常生活の指導・遊びの指導・生活単元学習・作業学習）の話題が出たとき、
各教科との関連を以下の形式で示すこと。

- 関連教科の判断基準（厳守）：
  ・作業学習の主関連は「在籍学部の教科名」で、中身は「発達段階に対応する教科の内容」。
  ・「体育」は豊かなスポーツライフの構築が目的。体の動かし方・姿勢・操作性の課題は「自立活動」が正しい。
  ・「図画工作」は造形・表現が目的。作業活動そのものとは別物。安直に当てはめるな。
  ・自立活動は教科ではなく「障害による困難を改善・克服する」領域。肢体不自由・コミュニケーション等に関わる。

- 提示形式（「この特性を〜に活かすとしたら」の直後に配置）：
  　主な関連：[教科名（学部）] [段階] [目標/内容の箇所] 原文一言一句
  　　→ 【引用：各教科目標と内容txt/該当ファイル名.txt｜原文一言一句】
  　その他の関連：同形式で1〜2つ。ただし以下の系統性ルールを厳守すること。

- 【各教科の引用ルール（厳守）】
  引用対象は「2 各段階の目標及び内容」以降のみ。「1 目 標」は引用しない。
  必ず以下の順序・書式で記述すること：

  ① 段階見出し：○X段階（1段階〜3段階のいずれか。ファイル内の表記そのまま）
  ② 目標：(1) 目 標 の原文をア・イ・ウ等の項目記号ごとそのまま記述する。
  ③ 内容：関連する (2) 内 容 の原文を「A 〇〇」などの区分名ごとそのまま記述する。
  ④ 引用タグ：【引用：各教科目標と内容txt/ファイル名.txt｜上記で引用した原文の一節】

  ＜書式例（小学部体育 1段階の場合）＞
  ○1段階
  (1) 目 標
  ア 教師と一緒に,楽しく体を動かすことができるようにするとともに,健康な生活に必要な事柄ができるようにする。
  【引用：各教科目標と内容txt/小学部　体育.txt｜ア 教師と一緒に,楽しく体を動かすことができるようにするとともに,健康な生活に必要な事柄ができるようにする。】

  ・項目記号は原文のまま（ア・イ・ウ）を使え。(7) や (ｱ) など独自番号に置き換えるな。
  ・AIが要約・言い換え・補足を加えることは禁止。原文以外の文字を引用文に混ぜるな。

- 【自立活動の引用ルール（各教科とは別書式・厳守）】
  自立活動には「段階」は存在しない。以下の書式で引用する。

  ① 区分番号と区分名：「X 〇〇」（例：「５ 身体の動き」）
  ② 項目：「(X) 〇〇に関すること。」の原文そのまま
  ③ 引用タグ：【引用：詳細txt/自立txt/X　〇〇.txt｜上記の原文】
     ※ 概要のみ示す場合は【引用：各教科目標と内容txt/自立活動.txt｜原文】

  ＜書式例（身体の動き の場合）＞
  【５ 身体の動き】
  （3） 日常生活に必要な基本動作に関すること。
  【引用：詳細txt/自立txt/５　身体の動き.txt｜（3） 日常生活に必要な基本動作に関すること。】

  ・「段階」という語を使うな。自立活動に段階はない。
  ・区分（1〜6）と項目番号は原文のまま。「（1）」を「1.」等に変えるな。

- 【系統性ルール（厳守）】教科の系統を意識し、同じ系列の上位・下位学部の教科を「その他の関連」に並列で挙げるな。
  系列の例：
  　小学部「生活科」→ 中学部「職業・家庭」→ 高等部「職業」「家庭」「情報」
  　小学部「国語」→ 中学部「国語」→ 高等部「国語」（算数・数学、体育・保健体育も同様）
  同じ系列の教科は、発達段階に最も合う1つだけを根拠として引用すること。
  高等部在籍で中身を「生活科（小学部）」にする場合、「職業・家庭（中学部）」を別途「その他の関連」に加えることは系統上の重複であり、不適切。
  「その他の関連」には、別の系列の教科（例：自立活動、国語、算数など）を挙げること。

- ファイル名は knowledge_data.js に登録されている以下のキーから正確に選べ：

  【小学部】
  　各教科目標と内容txt/小学部　生活科.txt
  　各教科目標と内容txt/小学部　国語.txt
  　各教科目標と内容txt/小学部　算数.txt
  　各教科目標と内容txt/小学部　音楽.txt
  　各教科目標と内容txt/小学部　図画工作.txt
  　各教科目標と内容txt/小学部　体育.txt

  【中学部】
  　各教科目標と内容txt/中学部　職業・家庭.txt
  　各教科目標と内容txt/中学部　国語.txt
  　各教科目標と内容txt/中学部　数学.txt
  　各教科目標と内容txt/中学部　音楽.txt
  　各教科目標と内容txt/中学部　美術.txt
  　各教科目標と内容txt/中学部　保健体育.txt
  　各教科目標と内容txt/中学部　理科.txt
  　各教科目標と内容txt/中学部　社会科.txt
  　各教科目標と内容txt/中学部　外国語.txt

  【高等部】
  　各教科目標と内容txt/高等部　職業.txt
  　各教科目標と内容txt/高等部　家庭.txt
  　各教科目標と内容txt/高等部　国語.txt
  　各教科目標と内容txt/高等部　数学.txt
  　各教科目標と内容txt/高等部　音楽.txt
  　各教科目標と内容txt/高等部　美術.txt
  　各教科目標と内容txt/高等部　保健体育.txt
  　各教科目標と内容txt/高等部　理科.txt
  　各教科目標と内容txt/高等部　社会.txt
  　各教科目標と内容txt/高等部　外国語.txt
  　各教科目標と内容txt/高等部　情報.txt

  【自立活動】（段階なし。区分番号＋項目で引用する）
  　各教科目標と内容txt/自立活動.txt　← 全区分の概要
  　詳細txt/自立txt/１　健康の保持.txt
  　詳細txt/自立txt/２　心理的な安定.txt
  　詳細txt/自立txt/３　人間関係の形成.txt
  　詳細txt/自立txt/４　環境の把握.txt
  　詳細txt/自立txt/５　身体の動き.txt
  　詳細txt/自立txt/６　コミュニケーション.txt

---
### 参照知識（ソース）:
${materialsContext}
`;
    const body = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        temperature: 0.7,
        system: systemInstruction,
        messages: messages.map(m => ({
            role: m.role === 'model' ? 'assistant' : 'user',
            content: m.parts[0].text
        }))
    };

    let maxRetries = 3;
    let baseDelay = 1500;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                const e = await res.json().catch(() => ({}));
                const status = res.status;
                if (status === 429 || status >= 500) {
                    throw new Error(`HTTP ${status}: ${e.error?.message || 'レート制限またはサーバーエラー'}`);
                }
                throw new Error(e.error?.message || '送信エラー');
            }
            const data = await res.json();
            return data?.content?.[0]?.text || '返答なし';
        } catch (err) {
            console.warn(`API試行 ${attempt + 1}/${maxRetries} 失敗:`, err.message);
            if (attempt === maxRetries - 1) {
                if (err.message.includes('429') || err.message.includes('Quota')) {
                    throw new Error('トークン制限に達しました。少し時間をおいてから再度お試しください。');
                }
                throw err;
            }
            const sendBtn = document.getElementById('send-btn');
            if (sendBtn) sendBtn.textContent = `再試行中(${attempt + 1})...`;
            const delay = baseDelay * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
