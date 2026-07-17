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
    const providerSelect = $('#providerSelect');
    const modelSelect = $('#modelSelect');
    const reasoningSelect = $('#reasoningSelect');
    const resetBtn = $('#resetBtn');

    // ================================================================
    //  Providers
    // ================================================================
    // Responses are streamed (SSE), so generous output ceilings are safe —
    // streaming avoids the HTTP timeout that long non-streaming calls hit.
    // A model entry may carry extra per-model request params (e.g. Gemini
    // thinkingLevel). Models are selected by index, so the same id can appear
    // more than once with different params.
    const EFFORT_LABELS = {
        none: 'None',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'Extra high',
        max: 'Maximum',
    };
    const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'max'];
    const CLAUDE_XHIGH_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    const OPENAI_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];
    const OPENAI_56_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

    const PROVIDERS = {
        claude: {
            label: 'Anthropic Claude',
            keyPlaceholder: 'Enter your Anthropic API key (sk-ant-…)',
            maxTokens: 64000,
            models: [
                { id: 'claude-fable-5', label: 'Claude Fable 5', effortLevels: CLAUDE_XHIGH_EFFORTS, defaultEffort: 'high' },
                { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', effortLevels: CLAUDE_XHIGH_EFFORTS, defaultEffort: 'high' },
                { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', effortLevels: CLAUDE_XHIGH_EFFORTS, defaultEffort: 'high' },
                { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', effortLevels: CLAUDE_EFFORTS, defaultEffort: 'high' },
                { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
            ],
            stream: streamClaude,
        },
        openai: {
            label: 'OpenAI ChatGPT',
            keyPlaceholder: 'Enter your OpenAI API key (sk-…)',
            maxTokens: 64000,
            models: [
                { id: 'gpt-5.6', label: 'GPT-5.6 (Sol)', effortLevels: OPENAI_56_EFFORTS, defaultEffort: 'medium' },
                { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', effortLevels: OPENAI_56_EFFORTS, defaultEffort: 'medium' },
                { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', effortLevels: OPENAI_56_EFFORTS, defaultEffort: 'medium' },
                { id: 'chat-latest', label: 'ChatGPT Instant (latest)' },
                { id: 'gpt-5.5', label: 'GPT-5.5', effortLevels: OPENAI_EFFORTS, defaultEffort: 'medium' },
                { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', effortLevels: OPENAI_EFFORTS, defaultEffort: 'none' },
                { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', effortLevels: OPENAI_EFFORTS, defaultEffort: 'none' },
            ],
            stream: streamOpenAI,
        },
        gemini: {
            label: 'Google Gemini',
            keyPlaceholder: 'Enter your Generative Language API key',
            maxTokens: 65536,
            models: [
                { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
                { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
                // "Extended" = Flash at the deepest reasoning level (there is no
                // separate "extended" model — it's the thinkingLevel setting).
                { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (Extended thinking)', thinkingLevel: 'HIGH' },
                { id: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash' },
            ],
            stream: streamGemini,
        },
    };

    // ── State ──
    // Each entry: { file: File, text: string|null, base64: string|null, mimeType: string|null }
    let uploadedFiles = [];
    let isProcessing = false;
    let lastApiKey = '';
    let lastPrompt = '';
    let lastProvider = 'claude';
    let lastModel = PROVIDERS.claude.models[0]; // model descriptor object
    let lastReasoningEffort = lastModel.defaultEffort;
    // Remembers a key per provider so switching providers doesn't lose it
    const apiKeys = {};
    // Stores raw result text keyed by filename
    const resultTexts = new Map();
    // Map result cards to their source files for retry/download
    const cardFileMap = new WeakMap();

    // ── Browser persistence ──
    // Small settings stay in localStorage for fast synchronous restoration.
    // Files and generated results live in IndexedDB, which has a much larger
    // quota and stores File/Blob objects without base64 expansion.
    const STORAGE_KEY = 'multiFilePromptApp.state.v1';
    const DATABASE_NAME = 'multiFilePromptApp';
    const DATABASE_VERSION = 1;
    const FILE_STORE = 'files';
    const RESULT_STORE = 'results';
    const DEFAULT_PROVIDER = 'claude';
    const DEFAULT_STAGGER_DELAY = '2';
    let saveTimer = null;
    let saveRevision = 0;
    let isRestoring = false;
    let hasShownStorageWarning = false;
    let shouldPersistState = false;
    let databasePromise = null;
    let databaseWriteChain = Promise.resolve();

    function scheduleStateSave() {
        if (isRestoring) return;
        shouldPersistState = true;
        clearTimeout(saveTimer);
        const revision = ++saveRevision;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            persistState(revision);
        }, 250);
    }

    function persistState(revision) {
        if (revision !== saveRevision || isRestoring) return;
        writeSavedState(buildSavedState());
    }

    function buildSavedState() {
        apiKeys[currentProvider()] = apiKeyInput.value;

        const lastModelIndex = PROVIDERS[lastProvider]
            ? PROVIDERS[lastProvider].models.indexOf(lastModel)
            : 0;

        return {
            version: 2,
            provider: currentProvider(),
            modelIndex: Number(modelSelect.value) || 0,
            reasoningEffort: currentReasoningEffort(),
            apiKeys: { ...apiKeys },
            prompt: promptText.value,
            staggerDelay: staggerDelay.value,
            fileIds: uploadedFiles.map(item => item.id),
            lastRun: lastApiKey ? {
                provider: lastProvider,
                modelIndex: Math.max(0, lastModelIndex),
                reasoningEffort: lastReasoningEffort,
                prompt: lastPrompt,
            } : null,
        };
    }

    function writeSavedState(state, silent = false) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            if (!silent) {
                showStorageWarning('This browser could not save the page settings locally.');
            }
        }
    }

    function showStorageWarning(message) {
        if (hasShownStorageWarning) return;
        hasShownStorageWarning = true;
        showToast(message, 'error');
    }

    function persistCachedState() {
        if (isRestoring || !shouldPersistState) return;
        clearTimeout(saveTimer);
        saveTimer = null;
        saveRevision++;
        writeSavedState(buildSavedState(), true);
    }

    function createFileId() {
        return crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function openDatabase() {
        if (databasePromise) return databasePromise;
        if (!window.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'));

        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(FILE_STORE)) {
                    database.createObjectStore(FILE_STORE, { keyPath: 'id' });
                }
                if (!database.objectStoreNames.contains(RESULT_STORE)) {
                    database.createObjectStore(RESULT_STORE, { keyPath: 'fileId' });
                }
            };
            request.onsuccess = () => {
                const database = request.result;
                database.onversionchange = () => database.close();
                resolve(database);
            };
            request.onerror = () => reject(request.error || new Error('Could not open IndexedDB'));
            request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked'));
        }).catch((error) => {
            databasePromise = null;
            throw error;
        });

        return databasePromise;
    }

    async function runDatabaseWrite(storeNames, operation) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(storeNames, 'readwrite');
            const stores = Object.fromEntries(
                storeNames.map(name => [name, transaction.objectStore(name)])
            );
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write was aborted'));
            try {
                operation(stores);
            } catch (error) {
                transaction.abort();
                reject(error);
            }
        });
    }

    function enqueueDatabaseWrite(operation, warningMessage = 'Files or results could not be saved in IndexedDB.') {
        const write = databaseWriteChain.then(operation);
        databaseWriteChain = write.catch(() => {});
        if (warningMessage) write.catch(() => showStorageWarning(warningMessage));
        return write;
    }

    function persistFileItems(items) {
        if (!items.length) return Promise.resolve();
        return enqueueDatabaseWrite(() => runDatabaseWrite([FILE_STORE], stores => {
            items.forEach(item => stores[FILE_STORE].put({
                id: item.id,
                name: item.file.name,
                type: item.file.type,
                lastModified: item.file.lastModified,
                blob: item.file,
            }));
        }), 'One or more uploaded files could not be saved in IndexedDB.');
    }

    function deletePersistedFile(fileId) {
        return enqueueDatabaseWrite(() => runDatabaseWrite([FILE_STORE, RESULT_STORE], stores => {
            stores[FILE_STORE].delete(fileId);
            stores[RESULT_STORE].delete(fileId);
        }));
    }

    function persistResult(fileItem, text) {
        return enqueueDatabaseWrite(() => runDatabaseWrite([RESULT_STORE], stores => {
            stores[RESULT_STORE].put({ fileId: fileItem.id, text });
        }), 'A generated result could not be saved in IndexedDB.');
    }

    function clearPersistedResults() {
        return enqueueDatabaseWrite(() => runDatabaseWrite([RESULT_STORE], stores => {
            stores[RESULT_STORE].clear();
        }));
    }

    function clearPersistedDatabase() {
        return enqueueDatabaseWrite(() => runDatabaseWrite([FILE_STORE, RESULT_STORE], stores => {
            stores[FILE_STORE].clear();
            stores[RESULT_STORE].clear();
        }), null);
    }

    function replacePersistedDatabase(items) {
        return enqueueDatabaseWrite(() => runDatabaseWrite([FILE_STORE, RESULT_STORE], stores => {
            stores[FILE_STORE].clear();
            stores[RESULT_STORE].clear();
            items.forEach(item => {
                stores[FILE_STORE].put({
                    id: item.id,
                    name: item.file.name,
                    type: item.file.type,
                    lastModified: item.file.lastModified,
                    blob: item.file,
                });
                const result = resultTexts.get(item.file.name);
                if (typeof result === 'string') {
                    stores[RESULT_STORE].put({ fileId: item.id, text: result });
                }
            });
        }), null);
    }

    async function readDatabaseRecords(storeName, ids) {
        if (!ids.length) return new Map();
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const records = new Map();
            ids.forEach(id => {
                const request = store.get(id);
                request.onsuccess = () => {
                    if (request.result) records.set(id, request.result);
                };
            });
            transaction.oncomplete = () => resolve(records);
            transaction.onerror = () => reject(transaction.error || new Error('IndexedDB read failed'));
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB read was aborted'));
        });
    }

    async function restoreSavedState() {
        let saved;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            saved = JSON.parse(raw);
        } catch (error) {
            try { localStorage.removeItem(STORAGE_KEY); } catch (storageError) { /* no-op */ }
            return;
        }
        if (!saved || ![1, 2].includes(saved.version)) return;

        shouldPersistState = true;
        isRestoring = true;
        try {
            Object.keys(apiKeys).forEach(provider => delete apiKeys[provider]);
            if (saved.apiKeys && typeof saved.apiKeys === 'object') {
                Object.entries(saved.apiKeys).forEach(([provider, key]) => {
                    if (PROVIDERS[provider] && typeof key === 'string') apiKeys[provider] = key;
                });
            }

            providerSelect.value = PROVIDERS[saved.provider] ? saved.provider : DEFAULT_PROVIDER;
            populateModels();
            const modelIndex = Number(saved.modelIndex);
            if (Number.isInteger(modelIndex) && PROVIDERS[currentProvider()].models[modelIndex]) {
                modelSelect.value = String(modelIndex);
            }
            populateReasoningEfforts();
            if (!reasoningSelect.disabled
                && [...reasoningSelect.options].some(option => option.value === saved.reasoningEffort)) {
                reasoningSelect.value = saved.reasoningEffort;
            }
            syncProviderUI();

            promptText.value = typeof saved.prompt === 'string' ? saved.prompt : '';
            const savedDelay = Number(saved.staggerDelay);
            staggerDelay.value = Number.isFinite(savedDelay)
                ? String(Math.min(30, Math.max(0, savedDelay)))
                : DEFAULT_STAGGER_DELAY;

            resultTexts.clear();

            if (saved.version === 2) {
                const fileIds = Array.isArray(saved.fileIds)
                    ? saved.fileIds.filter(id => typeof id === 'string')
                    : [];
                const [fileRecords, resultRecords] = await Promise.all([
                    readDatabaseRecords(FILE_STORE, fileIds),
                    readDatabaseRecords(RESULT_STORE, fileIds),
                ]);
                uploadedFiles = fileIds
                    .map(id => databaseRecordToFileItem(fileRecords.get(id)))
                    .filter(Boolean);
                uploadedFiles.forEach(item => {
                    const result = resultRecords.get(item.id)?.text;
                    if (typeof result === 'string') resultTexts.set(item.file.name, result);
                });
            } else {
                // Migrate existing v1 localStorage saves into IndexedDB once.
                uploadedFiles = Array.isArray(saved.files)
                    ? saved.files.map(deserializeLegacyFileItem).filter(Boolean)
                    : [];
                const availableFiles = new Set(uploadedFiles.map(item => item.file.name));
                if (Array.isArray(saved.results)) {
                    saved.results.forEach((entry) => {
                        if (Array.isArray(entry) && entry.length === 2
                            && availableFiles.has(entry[0]) && typeof entry[1] === 'string') {
                            resultTexts.set(entry[0], entry[1]);
                        }
                    });
                }
            }

            restoreLastRun(saved.lastRun);
            renderFileList();
            restoreResults();
            if (saved.version === 1) {
                try {
                    await replacePersistedDatabase(uploadedFiles);
                    writeSavedState(buildSavedState());
                } catch (error) {
                    showStorageWarning('The previous local save could not be migrated to IndexedDB.');
                }
            }
        } catch (error) {
            uploadedFiles = [];
            resultTexts.clear();
            renderFileList();
            restoreResults();
            showStorageWarning('Files and results could not be restored from IndexedDB.');
        } finally {
            isRestoring = false;
        }
    }

    function databaseRecordToFileItem(record) {
        if (!record || typeof record.id !== 'string' || !(record.blob instanceof Blob)) return null;
        const file = new File([record.blob], record.name || 'saved-file', {
            type: record.type || record.blob.type,
            lastModified: Number(record.lastModified) || Date.now(),
        });
        return {
            id: record.id,
            file,
            text: null,
            base64: null,
            mimeType: null,
        };
    }

    function deserializeLegacyFileItem(savedFile) {
        try {
            if (!savedFile || typeof savedFile.name !== 'string' || typeof savedFile.dataUrl !== 'string') {
                return null;
            }
            const file = dataUrlToFile(savedFile.dataUrl, savedFile);
            return {
                id: createFileId(),
                file,
                text: null,
                base64: null,
                mimeType: null,
            };
        } catch (error) {
            return null;
        }
    }

    function dataUrlToFile(dataUrl, metadata) {
        const commaIndex = dataUrl.indexOf(',');
        if (commaIndex < 0) throw new Error('Invalid saved file');
        const header = dataUrl.slice(0, commaIndex);
        const encoded = dataUrl.slice(commaIndex + 1);
        const binary = header.includes(';base64') ? atob(encoded) : decodeURIComponent(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const headerType = header.match(/^data:([^;,]*)/)?.[1] || '';
        return new File([bytes], metadata.name, {
            type: metadata.type || headerType,
            lastModified: Number(metadata.lastModified) || Date.now(),
        });
    }

    function restoreLastRun(savedLastRun) {
        const provider = savedLastRun && PROVIDERS[savedLastRun.provider]
            ? savedLastRun.provider
            : currentProvider();
        const models = PROVIDERS[provider].models;
        const modelIndex = Number(savedLastRun?.modelIndex);
        lastProvider = provider;
        lastModel = Number.isInteger(modelIndex) && models[modelIndex] ? models[modelIndex] : models[0];
        lastReasoningEffort = typeof savedLastRun?.reasoningEffort === 'string'
            ? savedLastRun.reasoningEffort
            : (lastModel.defaultEffort || null);
        lastPrompt = typeof savedLastRun?.prompt === 'string' ? savedLastRun.prompt : promptText.value.trim();
        lastApiKey = apiKeys[lastProvider] || '';
    }

    function restoreResults() {
        resultsGrid.innerHTML = '';
        const completedItems = uploadedFiles.filter(item => resultTexts.has(item.file.name));
        resultsSection.classList.toggle('visible', completedItems.length > 0);
        completedItems.forEach((item, index) => {
            const card = createResultCard(item, index);
            setCardResult(card, resultTexts.get(item.file.name));
            setCardStatus(card, 'done');
        });
        updateStats();
    }

    function resetPage() {
        if (isProcessing) return;
        clearTimeout(saveTimer);
        saveTimer = null;
        saveRevision++;
        isRestoring = true;

        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (error) {
            // The in-memory page can still be reset if storage is unavailable.
        }
        const databaseClear = clearPersistedDatabase();

        uploadedFiles = [];
        resultTexts.clear();
        Object.keys(apiKeys).forEach(provider => delete apiKeys[provider]);
        lastApiKey = '';
        lastPrompt = '';
        lastProvider = DEFAULT_PROVIDER;
        lastModel = PROVIDERS[DEFAULT_PROVIDER].models[0];
        lastReasoningEffort = lastModel.defaultEffort;

        providerSelect.value = DEFAULT_PROVIDER;
        populateModels();
        syncProviderUI();
        apiKeyInput.type = 'password';
        toggleApiKeyBtn.querySelector('.eye-icon').style.display = '';
        toggleApiKeyBtn.querySelector('.eye-off-icon').style.display = 'none';
        promptText.value = '';
        staggerDelay.value = DEFAULT_STAGGER_DELAY;
        fileInput.value = '';
        promptFileInput.value = '';
        renderFileList();
        resultsGrid.innerHTML = '';
        resultsStats.innerHTML = '';
        resultsSection.classList.remove('visible');
        downloadMenu.classList.remove('open');
        toastContainer.innerHTML = '';
        hasShownStorageWarning = false;
        shouldPersistState = false;
        isRestoring = false;
        databaseClear
            .then(() => showToast('Page reset and saved data deleted.', 'success'))
            .catch(() => showToast('Page reset, but IndexedDB could not be fully cleared.', 'error'));
    }

    // ================================================================
    //  Provider / Model selectors
    // ================================================================
    function currentProvider() {
        return providerSelect.value || 'claude';
    }

    function populateProviders() {
        providerSelect.innerHTML = Object.entries(PROVIDERS)
            .map(([id, p]) => `<option value="${id}">${escapeHtml(p.label)}</option>`)
            .join('');
        providerSelect.value = 'claude';
    }

    function populateModels() {
        const provider = PROVIDERS[currentProvider()];
        // value = index, so two entries can share a model id with different params
        modelSelect.innerHTML = provider.models
            .map((m, i) => `<option value="${i}">${escapeHtml(m.label)}</option>`)
            .join('');
        modelSelect.value = '0';
        populateReasoningEfforts();
    }

    function currentModel() {
        const models = PROVIDERS[currentProvider()].models;
        return models[Number(modelSelect.value)] || models[0];
    }

    function populateReasoningEfforts() {
        const model = currentModel();
        const levels = model.effortLevels || [];

        if (!levels.length) {
            const fixedLabel = model.thinkingLevel
                ? `Reasoning: ${EFFORT_LABELS[model.thinkingLevel.toLowerCase()] || model.thinkingLevel} (preset)`
                : 'Reasoning: Not configurable';
            reasoningSelect.innerHTML = `<option value="">${escapeHtml(fixedLabel)}</option>`;
            reasoningSelect.disabled = true;
            reasoningSelect.title = fixedLabel;
            return;
        }

        reasoningSelect.innerHTML = levels
            .map(level => `<option value="${level}">Reasoning: ${EFFORT_LABELS[level]}</option>`)
            .join('');
        reasoningSelect.disabled = false;
        reasoningSelect.value = model.defaultEffort || levels[0];
        reasoningSelect.title = 'Controls reasoning depth, latency, and token use';
    }

    function currentReasoningEffort() {
        return reasoningSelect.disabled ? null : (reasoningSelect.value || null);
    }

    function syncProviderUI() {
        const provider = PROVIDERS[currentProvider()];
        apiKeyInput.placeholder = provider.keyPlaceholder;
        apiKeyInput.value = apiKeys[currentProvider()] || '';
    }

    providerSelect.addEventListener('change', () => {
        populateModels();
        syncProviderUI();
        scheduleStateSave();
    });
    modelSelect.addEventListener('change', () => {
        populateReasoningEfforts();
        scheduleStateSave();
    });
    reasoningSelect.addEventListener('change', scheduleStateSave);
    apiKeyInput.addEventListener('input', () => {
        apiKeys[currentProvider()] = apiKeyInput.value;
        scheduleStateSave();
    });
    promptText.addEventListener('input', scheduleStateSave);
    staggerDelay.addEventListener('input', scheduleStateSave);
    resetBtn.addEventListener('click', resetPage);
    window.addEventListener('pagehide', persistCachedState);

    populateProviders();
    populateModels();
    syncProviderUI();
    restoreSavedState();

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

    function isPptx(file) {
        return file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            || file.name.toLowerCase().endsWith('.pptx');
    }

    // Extract structured text from PPTX using JSZip
    async function extractPptxText(file) {
        const data = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(data);

        // Find all slide XML files (ppt/slides/slide1.xml, slide2.xml, ...)
        const slideFiles = Object.keys(zip.files)
            .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
            .sort((a, b) => {
                const numA = parseInt(a.match(/slide(\d+)/i)[1]);
                const numB = parseInt(b.match(/slide(\d+)/i)[1]);
                return numA - numB;
            });

        if (slideFiles.length === 0) {
            throw new Error('No slides found in PPTX file');
        }

        const slides = [];
        for (const slidePath of slideFiles) {
            const xml = await zip.file(slidePath).async('string');
            // Parse XML and extract all text runs
            const parser = new DOMParser();
            const doc = parser.parseFromString(xml, 'application/xml');
            // Get all <a:t> text elements (PowerPoint text runs)
            const textNodes = doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 't');
            const texts = [];
            for (const node of textNodes) {
                const t = node.textContent.trim();
                if (t) texts.push(t);
            }
            const slideNum = slidePath.match(/slide(\d+)/i)[1];
            slides.push(`--- Slide ${slideNum} ---\n${texts.join('\n')}`);
        }

        return slides.join('\n\n');
    }

    function addFiles(fileListObj) {
        const addedItems = [];
        for (const file of fileListObj) {
            // Avoid duplicates by name + size
            if (uploadedFiles.some(f => f.file.name === file.name && f.file.size === file.size)) continue;
            const item = {
                id: createFileId(),
                file,
                text: null,
                base64: null,
                mimeType: null,
            };
            uploadedFiles.push(item);
            addedItems.push(item);
        }
        renderFileList();
        persistFileItems(addedItems);
        scheduleStateSave();
    }

    function removeFile(index) {
        const [removedItem] = uploadedFiles.splice(index, 1);
        if (removedItem) deletePersistedFile(removedItem.id);
        renderFileList();
        scheduleStateSave();
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
        reader.onload = () => {
            promptText.value = reader.result;
            scheduleStateSave();
        };
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
        const providerLabel = PROVIDERS[currentProvider()].label;
        if (!apiKey) { showToast(`Please enter your ${providerLabel} API key.`, 'error'); apiKeyInput.focus(); return; }
        if (!uploadedFiles.length) { showToast('Please upload at least one file.', 'error'); return; }
        const prompt = promptText.value.trim();
        if (!prompt) { showToast('Please enter a prompt.', 'error'); promptText.focus(); return; }

        startProcessing(apiKey, prompt, currentProvider(), currentModel(), currentReasoningEffort());
    });

    async function startProcessing(apiKey, prompt, provider, model, reasoningEffort) {
        isProcessing = true;
        processBtn.disabled = true;
        resetBtn.disabled = true;
        lastApiKey = apiKey;
        lastPrompt = prompt;
        lastProvider = provider;
        lastModel = model;
        lastReasoningEffort = reasoningEffort;
        scheduleStateSave();
        processBtn.innerHTML = `
            <svg class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
            Processing…`;

        // Read all files — PDFs as base64, PPTX as extracted text, everything else as text
        await Promise.all(uploadedFiles.map(async (item) => {
            if (isPdf(item.file)) {
                if (item.base64 === null) {
                    item.base64 = await readFileAsBase64(item.file);
                    item.mimeType = 'application/pdf';
                }
            } else if (isPptx(item.file)) {
                if (item.text === null) {
                    item.text = await extractPptxText(item.file);
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
        resultTexts.clear();
        clearPersistedResults();
        const cards = uploadedFiles.map((item, i) => createResultCard(item, i));
        updateStats();

        // Staggered parallel calls
        const delay = parseFloat(staggerDelay.value) || 0;
        const promises = uploadedFiles.map((item, i) => {
            return new Promise((resolve) => {
                setTimeout(async () => {
                    setCardStatus(cards[i], 'processing');
                    setCardProcessing(cards[i]);
                    updateStats();
                    try {
                        const result = await streamModel(provider, model, reasoningEffort, apiKey, prompt, item);
                        resultTexts.set(item.file.name, result);
                        persistResult(item, result);
                        setCardResult(cards[i], result);
                        setCardStatus(cards[i], 'done');
                        scheduleStateSave();
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
        resetBtn.disabled = false;
        processBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg>
            Process All Files`;
        showToast('All files processed!', 'success');
        scheduleStateSave();
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
        // Also close any card download dropdowns
        document.querySelectorAll('.card-dl-menu.open').forEach(m => {
            if (!m.parentElement.contains(e.target)) m.classList.remove('open');
        });
    });
    downloadMenu.querySelectorAll('.dropdown-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const format = btn.dataset.format;
            downloadMenu.classList.remove('open');
            downloadAllAs(format);
        });
    });

    async function downloadAllAs(format) {
        if (resultTexts.size === 0) {
            showToast('No results to download yet.', 'error');
            return;
        }

        const entries = [...resultTexts.entries()];
        showToast(`Downloading ${entries.length} file${entries.length !== 1 ? 's' : ''} as .${format}…`, 'success');

        for (let i = 0; i < entries.length; i++) {
            const [fileName, text] = entries[i];
            const baseName = fileName.replace(/\.[^.]+$/, '');
            const { content, mime } = prepareContent(text, format, fileName);

            const blob = new Blob([content], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${baseName}.${format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // Stagger downloads to avoid browser throttling
            if (i < entries.length - 1) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        showToast(`Finished downloading ${entries.length} file${entries.length !== 1 ? 's' : ''} as .${format}`, 'success');
    }

    // Strip markdown code fences (```html ... ``` or ```...```) from LLM output
    function stripCodeFences(text) {
        let s = text.trim();
        // Remove opening ```html or ``` (with optional language tag)
        s = s.replace(/^```[a-zA-Z]*\s*\n?/, '');
        // Remove closing ```
        s = s.replace(/\n?```\s*$/, '');
        return s.trim();
    }

    function prepareContent(text, format, fileName) {
        switch (format) {
            case 'html': return { content: stripCodeFences(text), mime: 'text/html' };
            case 'py': return { content: `# Generated from: ${fileName}\n# Prompt applied via Multi-File Prompt App\n\n"""\n${text}\n"""`, mime: 'text/x-python' };
            case 'md': return { content: text, mime: 'text/markdown' };
            case 'txt':
            default: return { content: text, mime: 'text/plain' };
        }
    }

    function downloadSingleResult(fileName, format) {
        const text = resultTexts.get(fileName);
        if (!text) { showToast('No result to download.', 'error'); return; }
        const baseName = fileName.replace(/\.[^.]+$/, '');
        const { content, mime } = prepareContent(text, format, fileName);
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`Downloaded ${baseName}.${format}`, 'success');
    }

    // ================================================================
    //  Model dispatch (streaming)
    // ================================================================
    // Keep the HTTP response streamed to avoid timeouts, but only update the DOM
    // after a response is complete. Per-token rendering is prohibitively costly
    // when many generations run in parallel.
    function streamModel(provider, model, reasoningEffort, apiKey, prompt, fileItem) {
        const cfg = PROVIDERS[provider];
        if (!cfg) throw new Error(`Unknown provider: ${provider}`);
        return cfg.stream(apiKey, model, prompt, fileItem, cfg.maxTokens, reasoningEffort);
    }

    // Shared SSE consumer. Retries the *connection* on rate limits (429) and
    // transient server errors (500/502/503/529) with exponential backoff
    // (honoring Retry-After) — once bytes start streaming there is no retry.
    // All three providers report errors as { error: { message } }, so error
    // extraction is shared. `extractDelta(json)` returns the incremental text
    // for one SSE chunk (or '' / undefined). Returns the accumulated text.
    async function consumeSSE(url, options, extractDelta, providerName) {
        const MAX_ATTEMPTS = 4;
        const RETRYABLE = new Set([429, 500, 502, 503, 529]);
        let resp, lastErr;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            resp = await fetch(url, options);
            if (resp.ok) break;

            const errData = await resp.json().catch(() => ({}));
            const msg = errData?.error?.message
                || (typeof errData?.error === 'string' ? errData.error : null)
                || `HTTP ${resp.status}`;
            lastErr = new Error(msg);
            if (!RETRYABLE.has(resp.status) || attempt === MAX_ATTEMPTS - 1) throw lastErr;

            const retryAfter = parseFloat(resp.headers.get('Retry-After'));
            const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, waitMs));
            resp = null;
        }
        if (!resp || !resp.ok) throw lastErr || new Error('Request failed');

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const chunks = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep the last (possibly incomplete) line
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                let json;
                try { json = JSON.parse(payload); } catch { continue; }
                // A mid-stream error event surfaces here for every provider.
                if (json.error) throw new Error(json.error.message || 'Stream error');
                const delta = extractDelta(json) || '';
                if (delta) chunks.push(delta);
            }
        }

        const full = chunks.join('');
        if (!full) throw new Error(`Empty response from ${providerName}`);
        return full;
    }

    // ── Anthropic Claude — POST /v1/messages (stream) ──
    async function streamClaude(apiKey, model, prompt, fileItem, maxTokens, reasoningEffort) {
        const content = [{ type: 'text', text: `${prompt}\n\n--- FILE: ${fileItem.file.name} ---` }];
        if (fileItem.base64) {
            content.push({
                type: 'document',
                source: { type: 'base64', media_type: fileItem.mimeType, data: fileItem.base64 }
            });
        } else {
            content[0].text += `\n\n${fileItem.text}`;
        }

        const requestBody = {
            model: model.id,
            max_tokens: maxTokens,
            stream: true,
            messages: [{ role: 'user', content }]
        };
        if (reasoningEffort) {
            requestBody.output_config = { effort: reasoningEffort };
        }

        return consumeSSE('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                // Required for direct browser (CORS) calls
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify(requestBody)
        }, (json) => {
            // Text arrives as content_block_delta events with a text_delta
            if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
                return json.delta.text;
            }
            return '';
        }, 'Claude');
    }

    // ── OpenAI ChatGPT — POST /v1/chat/completions (stream) ──
    async function streamOpenAI(apiKey, model, prompt, fileItem, maxTokens, reasoningEffort) {
        let content;
        if (fileItem.base64) {
            content = [
                { type: 'text', text: `${prompt}\n\n--- FILE: ${fileItem.file.name} ---` },
                {
                    type: 'file',
                    file: {
                        filename: fileItem.file.name,
                        file_data: `data:${fileItem.mimeType};base64,${fileItem.base64}`
                    }
                }
            ];
        } else {
            content = `${prompt}\n\n--- FILE: ${fileItem.file.name} ---\n\n${fileItem.text}`;
        }

        const requestBody = {
            model: model.id,
            // GPT-5.x are reasoning models → max_completion_tokens (not max_tokens)
            max_completion_tokens: maxTokens,
            stream: true,
            messages: [{ role: 'user', content }]
        };
        if (reasoningEffort) {
            requestBody.reasoning_effort = reasoningEffort;
        }

        return consumeSSE('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        }, (json) => json.choices?.[0]?.delta?.content || '', 'OpenAI');
    }

    // ── Google Gemini — streamGenerateContent (SSE) ──
    async function streamGemini(apiKey, model, prompt, fileItem, maxTokens) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

        const parts = [{ text: `${prompt}\n\n--- FILE: ${fileItem.file.name} ---` }];
        if (fileItem.base64) {
            parts.push({ inlineData: { mimeType: fileItem.mimeType, data: fileItem.base64 } });
        } else {
            parts[0].text += `\n\n${fileItem.text}`;
        }

        const generationConfig = { temperature: 0.7, maxOutputTokens: maxTokens };
        // "Extended thinking" model variant → deepest reasoning level
        if (model.thinkingLevel) {
            generationConfig.thinkingConfig = { thinkingLevel: model.thinkingLevel };
        }

        return consumeSSE(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts }], generationConfig })
        }, (json) => json.candidates?.[0]?.content?.parts?.[0]?.text || '', 'Gemini');
    }

    // ================================================================
    //  Result Cards
    // ================================================================
    function createResultCard(fileItem, index) {
        const fileName = fileItem.file.name;
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
                    <button class="retry-header-btn" title="Retry this file" disabled>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
                        Retry
                    </button>
                    <div class="dropdown card-download-dropdown">
                        <button class="download-single-btn" title="Download as…" disabled>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Download
                        </button>
                        <div class="dropdown-menu card-dl-menu">
                            <button class="dropdown-item" data-format="txt">.txt</button>
                            <button class="dropdown-item" data-format="md">.md</button>
                            <button class="dropdown-item" data-format="html">.html</button>
                            <button class="dropdown-item" data-format="py">.py</button>
                        </div>
                    </div>
                    <button class="copy-btn" title="Copy result" disabled>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                        Copy
                    </button>
                </div>
            </div>
            <div class="card-body">
                <div class="placeholder">Waiting to start…</div>
            </div>`;

        // Store mapping
        cardFileMap.set(card, fileItem);

        // Retry button in header
        card.querySelector('.retry-header-btn').addEventListener('click', () => {
            retryCard(card, fileItem);
        });

        // Download dropdown in header
        const dlBtn = card.querySelector('.download-single-btn');
        const dlMenu = card.querySelector('.card-dl-menu');
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close other open menus first
            document.querySelectorAll('.card-dl-menu.open').forEach(m => { if (m !== dlMenu) m.classList.remove('open'); });
            dlMenu.classList.toggle('open');
        });
        dlMenu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                dlMenu.classList.remove('open');
                const fmt = item.dataset.format;
                downloadSingleResult(fileItem.file.name, fmt);
            });
        });

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
        // Enable copy, download, retry
        const copyBtn = card.querySelector('.copy-btn');
        const downloadBtn = card.querySelector('.download-single-btn');
        const retryBtn = card.querySelector('.retry-header-btn');
        copyBtn.disabled = false;
        downloadBtn.disabled = false;
        retryBtn.disabled = false;
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
            </div>`;
        // Enable retry button in header
        const retryBtn = card.querySelector('.retry-header-btn');
        retryBtn.disabled = false;
    }

    function setCardProcessing(card) {
        const body = card.querySelector('.card-body');
        body.innerHTML = '<div class="placeholder">Generating response…</div>';
    }

    async function retryCard(card, fileItem) {
        if (!lastApiKey) { showToast('No API key available for retry.', 'error'); return; }
        setCardStatus(card, 'processing');
        setCardProcessing(card);
        updateStats();
        try {
            const result = await streamModel(lastProvider, lastModel, lastReasoningEffort, lastApiKey, lastPrompt, fileItem);
            resultTexts.set(fileItem.file.name, result);
            persistResult(fileItem, result);
            setCardResult(card, result);
            setCardStatus(card, 'done');
            scheduleStateSave();
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
    //  Markdown Renderer (marked + DOMPurify)
    // ================================================================
    // Configure marked once, if available.
    if (window.marked) {
        marked.setOptions({ gfm: true, breaks: true });
    }

    function renderMarkdown(text) {
        // Primary path: marked for parsing, DOMPurify to sanitize the result.
        if (window.marked && window.DOMPurify) {
            const rawHtml = marked.parse(text);
            const clean = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'rel'] });
            return clean;
        }
        // Fallback if the CDN libs failed to load: render as escaped, pre-wrapped text.
        return `<pre class="md-fallback">${escapeHtml(text)}</pre>`;
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
