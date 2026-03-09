/* ============================================================
   Multi-File Prompt Application — Core Logic
   ============================================================ */

(() => {
    'use strict';

    // ── DOM refs ──
    const $ = (sel) => document.querySelector(sel);
    const apiKeyInput = $('#apiKey');
    const toggleApiKeyBtn = $('#toggleApiKey');
    const dropZone = $('#dropZone');
    const fileInput = $('#fileInput');
    const browseFilesBtn = $('#browseFilesBtn');
    const fileList = $('#fileList');
    const fileCountEl = $('#fileCount');
    const promptText = $('#promptText');
    const importPromptBtn = $('#importPromptBtn');
    const promptFileInput = $('#promptFileInput');
    const staggerDelay = $('#staggerDelay');
    const processBtn = $('#processBtn');
    const resultsSection = $('#resultsSection');
    const resultsGrid = $('#resultsGrid');
    const resultsStats = $('#resultsStats');
    const toastContainer = $('#toastContainer');
    const downloadBtn = $('#downloadBtn');
    const downloadMenu = $('#downloadMenu');

    // ── State ──
    // Each entry: { file: File, text: string|null, base64: string|null, mimeType: string|null }
    let uploadedFiles = [];
    let isProcessing = false;
    let lastApiKey = '';
    let lastPrompt = '';
    // Stores raw result text keyed by filename
    const resultTexts = new Map();

    // ================================================================
    //  API Key Toggle
    // ================================================================
    toggleApiKeyBtn.addEventListener('click', () => {
        const isPass = apiKeyInput.type === 'password';
        apiKeyInput.type = isPass ? 'text' : 'password';
        toggleApiKeyBtn.querySelector('.eye-icon').style.display = isPass ? 'none' : '';
        toggleApiKeyBtn.querySelector('.eye-off-icon').style.display = isPass ? '' : 'none';
    });

    // ================================================================
    //  File Upload
    // ================================================================
    browseFilesBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
    dropZone.addEventListener('click', () => fileInput.click());

    // Drag & Drop
    ['dragenter', 'dragover'].forEach(evt =>
        dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); })
    );
    ['dragleave', 'drop'].forEach(evt =>
        dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-over'))
    );
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', () => {
        addFiles(fileInput.files);
        fileInput.value = '';
    });

    function isPdf(file) {
        return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    }

    function addFiles(fileListObj) {
        for (const file of fileListObj) {
            // Avoid duplicates by name + size
            if (uploadedFiles.some(f => f.file.name === file.name && f.file.size === file.size)) continue;
            uploadedFiles.push({ file, text: null, base64: null, mimeType: null });
        }
        renderFileList();
    }

    function removeFile(index) {
        uploadedFiles.splice(index, 1);
        renderFileList();
    }

    function renderFileList() {
        fileCountEl.textContent = `${uploadedFiles.length} file${uploadedFiles.length !== 1 ? 's' : ''}`;
        fileList.innerHTML = '';
        uploadedFiles.forEach((item, i) => {
            const li = document.createElement('li');
            li.innerHTML = `
                <div class="file-info">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <span class="file-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</span>
                    <span class="file-size">${formatBytes(item.file.size)}</span>
                </div>
                <button class="remove-file" title="Remove">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>`;
            li.querySelector('.remove-file').addEventListener('click', () => removeFile(i));
            fileList.appendChild(li);
        });
    }

    // ================================================================
    //  Prompt Import
    // ================================================================
    importPromptBtn.addEventListener('click', () => promptFileInput.click());
    promptFileInput.addEventListener('change', () => {
        const file = promptFileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { promptText.value = reader.result; };
        reader.readAsText(file);
        promptFileInput.value = '';
    });

    // ================================================================
    //  Process All Files
    // ================================================================
    processBtn.addEventListener('click', () => {
        if (isProcessing) return;
        // Validate
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) { showToast('Please enter your API key.', 'error'); apiKeyInput.focus(); return; }
        if (!uploadedFiles.length) { showToast('Please upload at least one file.', 'error'); return; }
        const prompt = promptText.value.trim();
        if (!prompt) { showToast('Please enter a prompt.', 'error'); promptText.focus(); return; }

        startProcessing(apiKey, prompt);
    });

    async function startProcessing(apiKey, prompt) {
        isProcessing = true;
        processBtn.disabled = true;
        lastApiKey = apiKey;
        lastPrompt = prompt;
        processBtn.innerHTML = `
            <svg class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
            Processing…`;

        // Read all files — PDFs as base64, everything else as text
        await Promise.all(uploadedFiles.map(async (item) => {
            if (isPdf(item.file)) {
                if (item.base64 === null) {
                    item.base64 = await readFileAsBase64(item.file);
                    item.mimeType = 'application/pdf';
                }
            } else {
                if (item.text === null) {
                    item.text = await readFileAsText(item.file);
                }
            }
        }));

        // Prepare results UI
        resultsSection.classList.add('visible');
        resultsGrid.innerHTML = '';
        const cards = uploadedFiles.map((item, i) => createResultCard(item.file.name, i));
        updateStats();

        // Staggered parallel calls
        const delay = parseFloat(staggerDelay.value) || 0;
        const promises = uploadedFiles.map((item, i) => {
            return new Promise((resolve) => {
                setTimeout(async () => {
                    setCardStatus(cards[i], 'processing');
                    updateStats();
                    try {
                        const result = await callGemini(apiKey, prompt, item);
                        resultTexts.set(item.file.name, result);
                        setCardResult(cards[i], result);
                        setCardStatus(cards[i], 'done');
                    } catch (err) {
                        setCardError(cards[i], err.message || 'Unknown error', item);
                        setCardStatus(cards[i], 'error');
                    }
                    updateStats();
                    resolve();
                }, i * delay * 1000);
            });
        });

        await Promise.allSettled(promises);
        isProcessing = false;
        processBtn.disabled = false;
        processBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg>
            Process All Files`;
        showToast('All files processed!', 'success');
    }

    // ================================================================
    //  Download All
    // ================================================================
    downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadMenu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
        if (!downloadMenu.contains(e.target) && e.target !== downloadBtn) {
            downloadMenu.classList.remove('open');
        }
    });
    downloadMenu.querySelectorAll('.dropdown-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const format = btn.dataset.format;
            downloadMenu.classList.remove('open');
            downloadAllAs(format);
        });
    });

    function downloadAllAs(format) {
        if (resultTexts.size === 0) {
            showToast('No results to download yet.', 'error');
            return;
        }

        resultTexts.forEach((text, fileName) => {
            const baseName = fileName.replace(/\.[^.]+$/, '');
            let content, mime;

            switch (format) {
                case 'html':
                    content = `<!DOCTYPE html>\n<html><head><meta charset="UTF-8"><title>${escapeHtml(baseName)}</title></head>\n<body>\n${renderMarkdown(text)}\n</body></html>`;
                    mime = 'text/html';
                    break;
                case 'py':
                    content = `# Generated from: ${fileName}\n# Prompt applied via Multi-File Prompt App\n\n"""\n${text}\n"""`;
                    mime = 'text/x-python';
                    break;
                case 'md':
                    content = text;
                    mime = 'text/markdown';
                    break;
                case 'txt':
                default:
                    content = text;
                    mime = 'text/plain';
                    break;
            }

            const blob = new Blob([content], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${baseName}.${format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });

        showToast(`Downloaded ${resultTexts.size} file${resultTexts.size !== 1 ? 's' : ''} as .${format}`, 'success');
    }

    // ================================================================
    //  Gemini API
    // ================================================================
    async function callGemini(apiKey, prompt, fileItem) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${encodeURIComponent(apiKey)}`;

        // Build parts array: prompt text + file content
        const parts = [
            { text: `${prompt}\n\n--- FILE: ${fileItem.file.name} ---` }
        ];

        if (fileItem.base64) {
            // PDF or binary file → send as inline data
            parts.push({
                inlineData: {
                    mimeType: fileItem.mimeType,
                    data: fileItem.base64
                }
            });
        } else {
            // Text file → append as text
            parts[0].text += `\n\n${fileItem.text}`;
        }

        const body = {
            contents: [{ parts }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 65536
            }
        };

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            const msg = errData?.error?.message || `HTTP ${resp.status}`;
            throw new Error(msg);
        }

        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Empty response from Gemini');
        return text;
    }

    // ================================================================
    //  Result Cards
    // ================================================================
    function createResultCard(fileName, index) {
        const card = document.createElement('div');
        card.className = 'result-card status-pending';
        card.style.animationDelay = `${index * 80}ms`;
        card.dataset.status = 'pending';
        card.innerHTML = `
            <div class="card-header">
                <div class="card-title">
                    <span class="status-dot pending"></span>
                    <span class="name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</span>
                </div>
                <div class="card-actions">
                    <button class="copy-btn" title="Copy result" disabled>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                        Copy
                    </button>
                </div>
            </div>
            <div class="card-body">
                <div class="placeholder shimmer">
                    <div class="shimmer-line"></div>
                    <div class="shimmer-line"></div>
                    <div class="shimmer-line"></div>
                </div>
            </div>`;
        resultsGrid.appendChild(card);
        return card;
    }

    function setCardStatus(card, status) {
        card.dataset.status = status;
        card.className = `result-card status-${status}`;
        const dot = card.querySelector('.status-dot');
        dot.className = `status-dot ${status}`;
    }

    function setCardResult(card, text) {
        const body = card.querySelector('.card-body');
        body.innerHTML = `<div class="result-content">${renderMarkdown(text)}</div>`;
        // Enable copy
        const copyBtn = card.querySelector('.copy-btn');
        copyBtn.disabled = false;
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
                setTimeout(() => {
                    copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy`;
                }, 2000);
            });
        });
    }

    function setCardError(card, message, fileItem) {
        const body = card.querySelector('.card-body');
        body.innerHTML = `
            <div class="error-content">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                <span>${escapeHtml(message)}</span>
            </div>
            <button class="retry-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
                Retry
            </button>`;
        body.querySelector('.retry-btn').addEventListener('click', () => retryCard(card, fileItem));
    }

    async function retryCard(card, fileItem) {
        if (!lastApiKey) { showToast('No API key available for retry.', 'error'); return; }
        setCardStatus(card, 'processing');
        // Reset body to shimmer
        const body = card.querySelector('.card-body');
        body.innerHTML = `<div class="placeholder shimmer"><div class="shimmer-line"></div><div class="shimmer-line"></div><div class="shimmer-line"></div></div>`;
        updateStats();
        try {
            const result = await callGemini(lastApiKey, lastPrompt, fileItem);
            resultTexts.set(fileItem.file.name, result);
            setCardResult(card, result);
            setCardStatus(card, 'done');
            showToast(`${fileItem.file.name} retried successfully!`, 'success');
        } catch (err) {
            setCardError(card, err.message || 'Unknown error', fileItem);
            setCardStatus(card, 'error');
        }
        updateStats();
    }

    function updateStats() {
        const cards = resultsGrid.querySelectorAll('.result-card');
        const counts = { pending: 0, processing: 0, done: 0, error: 0 };
        cards.forEach(c => counts[c.dataset.status]++);
        resultsStats.innerHTML = Object.entries(counts)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `<span class="stat"><span class="dot ${k}"></span>${v} ${k}</span>`)
            .join('');
    }

    // ================================================================
    //  Lightweight Markdown Renderer
    // ================================================================
    function renderMarkdown(text) {
        let html = escapeHtml(text);

        // Code blocks (``` ... ```)
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
            `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`
        );

        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Headers
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

        // Bold & Italic
        html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

        // Blockquote
        html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

        // Unordered lists
        html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
        html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

        // Ordered lists
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // Paragraphs — wrap remaining lines
        html = html.replace(/^(?!<[a-z])((?!<\/)[^\n]+)$/gm, '<p>$1</p>');

        // Clean up empty paragraphs
        html = html.replace(/<p>\s*<\/p>/g, '');

        return html;
    }

    // ================================================================
    //  Utilities
    // ================================================================
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
            reader.readAsText(file);
        });
    }

    function readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // result is "data:<mime>;base64,<data>" — extract just the base64 part
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
            reader.readAsDataURL(file);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
    }

    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('fade-out');
            toast.addEventListener('animationend', () => toast.remove());
        }, 3500);
    }

    // Add spinner animation via CSS
    const style = document.createElement('style');
    style.textContent = `.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
})();
