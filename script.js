// script.js - AnimeSAO Pro Premium Experience v3

const API_BASE = "/api";
const SECTIONS_CONFIG = [
    {
        id: "latest",
        title: "Añadidos Recientemente",
        type: "latest",
        endpoint: "latest",
    },
    {
        id: "trending",
        title: "Animes Populares",
        type: "trending",
        endpoint: "trending",
    },
    { id: "action", title: "Acción", type: "genre", endpoint: "genre/accion" },
    {
        id: "comedy",
        title: "Comedia",
        type: "genre",
        endpoint: "genre/comedia",
    },
    {
        id: "romance",
        title: "Romance",
        type: "genre",
        endpoint: "genre/romance",
    },
    {
        id: "fantasy",
        title: "Fantasía",
        type: "genre",
        endpoint: "genre/fantasia",
    },
    { id: "isekai", title: "Isekai", type: "genre", endpoint: "genre/isekai" },
    { id: "drama", title: "Drama", type: "genre", endpoint: "genre/drama" },
    {
        id: "shounen",
        title: "Shounen",
        type: "genre",
        endpoint: "genre/shounen",
    },
    {
        id: "mystery",
        title: "Misterio",
        type: "genre",
        endpoint: "genre/misterio",
    },
];

// ==================== STATE ====================
const AppState = {
    apiKey: localStorage.getItem("gemini_api_key") || "",
    aiPersonalization: localStorage.getItem("ai_personalization") !== "off",
    aiCatalogOnly: localStorage.getItem("ai_catalog_only") === "on",
    aiInstance: null,
    aiChat: null,
    aiMessages: [],
    library: (() => {
        try {
            const d = JSON.parse(localStorage.getItem("anime_library") || "[]");
            return Array.isArray(d) ? d : [];
        } catch (e) {
            console.warn("Library corrupted, resetting.");
            return [];
        }
    })(),
    history: (() => {
        try {
            const d = JSON.parse(localStorage.getItem("anime_history") || "[]");
            return Array.isArray(d) ? d : [];
        } catch (e) {
            console.warn("History corrupted, resetting.");
            return [];
        }
    })(),
    userPreferences: (() => {
        try {
            const d = JSON.parse(localStorage.getItem("anime_prefs") || "{}");
            return typeof d === "object" && d !== null && !Array.isArray(d)
                ? d
                : {};
        } catch (e) {
            return {};
        }
    })(),
    catalogIndex: [], // Store items for AI context
    currentAnime: null,
    currentEpisode: null,
    currentServers: [],
    currentServerIndex: 0,
    playerProgress: {},
    homeSections: new Map(),
    homeLoading: false,
    homeInitialized: false,
    sectionsLoading: new Set(),
    sectionPageCache: new Map(),
    categoryType: null,
    categoryGenre: null,
    categoryPage: 1,
    categoryLoading: false,
    categoryHasMore: true,
    searchTimeout: null,
    searchCache: new Map(),
    playerLoading: false,
    playerError: null,
    seenAnimeIds: new Set(),
    toastTimer: null,
    deferredPrompt: null,
    episodeSortOrder: 1, // 1: ASC, -1: DESC
    currentEpisodePage: 0,
    episodePageSize: 50,
};

// ==================== UTILITIES ====================
const $ = (id) => document.getElementById(id);

const showToast = (msg, duration = 2400) => {
    const toast = $("toast");
    if (!toast) return;

    clearTimeout(AppState.toastTimer);
    toast.textContent = msg;
    toast.classList.add("show");

    AppState.toastTimer = setTimeout(() => {
        toast.classList.remove("show");
        toast.textContent = "";
    }, duration);
};

const debounce = (fn, ms) => {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shuffleArray = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

// ==================== RECOMENDACIONES (SENIOR ENGINE v2) ====================
const Recommendations = {
    // k-factor: Sensibilidad al cambio.
    // 0.98 significa que después de 50 interacciones, un gusto antiguo vale solo 36% de su valor original.
    DECAY_RATE: 0.98,

    init() {
        // Aplicar decaimiento por tiempo transcurrido desde la última sesión
        const lastSession = parseInt(
            localStorage.getItem("last_session_time") || Date.now(),
        );
        const now = Date.now();
        const hoursPassed = (now - lastSession) / (1000 * 60 * 60);

        if (hoursPassed > 1) {
            const prefs = AppState.userPreferences;
            // Por cada hora de inactividad, perdemos un 1% de intensidad en los gustos antiguos
            // Esto permite que el usuario empiece "más fresco" después de dormir o no usar la app
            const timeDecay = Math.pow(0.99, hoursPassed);
            Object.keys(prefs).forEach((key) => {
                prefs[key] *= timeDecay;
                if (prefs[key] < 0.05) delete prefs[key];
            });
            localStorage.setItem("anime_prefs", JSON.stringify(prefs));
        }
        localStorage.setItem("last_session_time", now.toString());
    },

    track(action, anime) {
        if (!anime || !anime.genres) return;

        const weights = {
            view: 0.15, // Curiosidad
            play: 1.2, // Intención clara
            finish: 3.0, // Compromiso (Retención)
            library: 4.5, // Interés a largo plazo
        };

        const boost = weights[action] || 0.1;
        const prefs = AppState.userPreferences;

        // Decaimiento por interacción (Taste Shift)
        Object.keys(prefs).forEach((key) => {
            prefs[key] *= this.DECAY_RATE;
        });

        anime.genres.forEach((g) => {
            const key = g.toLowerCase().trim();
            if (key) {
                // El peso crece de forma logarítmica para evitar que un solo género domine infinitamente
                const current = prefs[key] || 0;
                prefs[key] = current + boost;
            }
        });

        localStorage.setItem("anime_prefs", JSON.stringify(prefs));
        localStorage.setItem("last_session_time", Date.now().toString());
    },

    // Cálculo de Jaccard Similarity para comparar animes entre sí
    calculateSimilarity(animeA, animeB) {
        if (!animeA.genres || !animeB.genres) return 0;
        const s1 = new Set(animeA.genres.map((g) => g.toLowerCase()));
        const s2 = new Set(animeB.genres.map((g) => g.toLowerCase()));
        const intersection = new Set([...s1].filter((x) => s2.has(x)));
        const union = new Set([...s1, ...s2]);
        return intersection.size / union.size;
    },

    scoreAnime(anime) {
        if (!anime || !anime.genres) return 0;
        const prefs = AppState.userPreferences;

        // 1. Alineación con el Perfil del Usuario
        let userScore = anime.genres.reduce((acc, g) => {
            const key = g.toLowerCase().trim();
            return acc + (prefs[key] || 0);
        }, 0);

        // 2. Bonus de Novedad (Favorece lo que no ha visto)
        const inHistory = AppState.history.some((h) => h.id === anime.id);
        const noveltyBonus = inHistory ? 0 : 0.8;

        // 3. Serendipia Dinámica
        const serendipity = Math.random() * 0.3;

        return userScore * (inHistory ? 0.3 : 1.0) + noveltyBonus + serendipity;
    },

    getRanked(items, limit = 15) {
        return items
            .map((item) => ({ item, score: this.scoreAnime(item) }))
            .sort((a, b) => b.score - a.score)
            .map((x) => x.item)
            .slice(0, limit);
    },

    getSimilar(targetAnime, allItems, limit = 8) {
        if (!targetAnime || !allItems) return [];
        return allItems
            .filter((a) => a.id !== targetAnime.id)
            .map((item) => ({
                item,
                sim:
                    this.calculateSimilarity(targetAnime, item) +
                    this.scoreAnime(item) * 0.1,
            }))
            .sort((a, b) => b.sim - a.sim)
            .map((x) => x.item)
            .slice(0, limit);
    },

    getTopGenre() {
        const prefs = AppState.userPreferences;
        const entries = Object.entries(prefs);
        if (entries.length === 0) return null;
        return entries.sort((a, b) => b[1] - a[1])[0][0];
    },

    // Métodos de compatibilidad
    registerAnime(anime, weightValue) {
        if (weightValue > 1) this.track("play", anime);
        else this.track("view", anime);
    },
    registerFavorite(anime, isFav) {
        if (isFav) this.track("library", anime);
    },
    registerEpisodeWatch(anime) {
        this.track("finish", anime);
    },
};

// ==================== API ====================
const API = {
    requestCache: new Map(),

    async fetch(endpoint, params = {}) {
        try {
            const queryString = new URLSearchParams(params).toString();
            const url = `${API_BASE}/${endpoint}${queryString ? "?" + queryString : ""}`;

            if (params.nocache) {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.json();
            }

            if (this.requestCache.has(url)) {
                return this.requestCache.get(url);
            }

            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            this.requestCache.set(url, data);
            setTimeout(() => this.requestCache.delete(url), 3 * 60 * 1000);

            return data;
        } catch (err) {
            console.error("[API Error]", err);
            return { success: false, error: err.message, data: null };
        }
    },

    getLatest(page = 1, nocache = false) {
        return this.fetch("latest", { page, nocache });
    },

    getTrending(nocache = false) {
        return this.fetch("trending", { nocache });
    },

    getGenre(genre, page = 1, nocache = false) {
        return this.fetch(`genre/${genre}`, { page, nocache });
    },

    search(query) {
        return this.fetch("search", { q: query });
    },

    getInfo(id) {
        const cleanId = id.replace("/anime/", "");
        return this.fetch(`info/${cleanId}`);
    },

    getVideo(id, cap) {
        const cleanId = id.replace("/anime/", "");
        return this.fetch(`video/${cleanId}/${cap}`);
    },
};

// ==================== UI BUILDER ====================
const UIBuilder = {
    buildCard(anime, isHistory = false) {
        const card = document.createElement("div");
        card.className = "card";

        const epTag =
            anime.lastEpisode && anime.lastEpisode !== "?"
                ? `<div class="ep-tag">EP ${anime.lastEpisode}</div>`
                : "";

        const historyItem = AppState.history.find((h) => h.id === anime.id);

        let progress = 0;
        if (historyItem) {
            if (
                historyItem.progressMap &&
                historyItem.progressMap[historyItem.lastEp]
            ) {
                progress = historyItem.progressMap[historyItem.lastEp];
            } else if (historyItem.progress !== undefined) {
                // Retrocompatibilidad
                progress = historyItem.progress;
            }
        }

        const progressHtml =
            progress > 0
                ? `<div class="card-progress-container"><div class="card-progress-bar" style="width: ${Math.min(progress, 100)}%;"></div></div>`
                : "";

        const coverUrl =
            anime.cover && anime.cover.length > 0
                ? anime.cover
                : "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

        card.innerHTML = `
            <div class="card-img-wrapper">
                ${epTag}
                <img src="${coverUrl}" alt="${anime.title}" loading="lazy">
                ${progressHtml}
            </div>
            <div class="card-title">${anime.title}</div>
        `;

        const img = card.querySelector("img");
        img.addEventListener("load", () => img.classList.add("loaded"));
        img.addEventListener("error", () => {
            img.src =
                "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
            img.classList.add("loaded");
        });

        card.addEventListener("click", () => {
            DetailOverlay.open(anime.id);
        });

        return card;
    },

    buildContinueCard(item) {
        const card = document.createElement("div");
        card.className = "cw-card";

        const progress =
            item.progress && item.duration && item.duration > 0
                ? Math.min((item.progress / item.duration) * 100, 99)
                : 0;

        const progressHtml =
            progress > 0
                ? `<div class="cw-progress-bar" style="width:${progress}%;"></div>`
                : "";

        const epLabel = item.lastEp ? `EP ${item.lastEp}` : "";
        const epBadge = epLabel
            ? `<div class="cw-ep-badge">${epLabel}</div>`
            : "";

        const coverUrl =
            item.cover && item.cover.length > 0
                ? item.cover
                : "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

        card.innerHTML = `
            <div class="cw-cover-wrap">
                ${epBadge}
                <img src="${coverUrl}" alt="${item.title}" loading="lazy">
                <div class="cw-play-icon">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="white" stroke="white" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </div>
                ${progressHtml}
            </div>
            <div class="cw-info">
                <div class="cw-name">${item.title}</div>
            </div>
        `;

        const img = card.querySelector("img");
        img.addEventListener("load", () => img.classList.add("loaded"));
        img.addEventListener("error", () => {
            img.src =
                "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
            img.classList.add("loaded");
        });

        card.addEventListener("click", () => {
            DetailOverlay.open(item.id);
        });

        return card;
    },

    renderHistorySection() {
        const container = $("continue-watching-container");
        if (!container) return;
        if (AppState.history.length === 0) {
            container.innerHTML = "";
            return;
        }

        const section = document.createElement("div");
        section.className = "continue-watching-section";
        section.innerHTML = `
            <div class="cw-header">
                <span class="cw-title">Seguir Viendo</span>
                <button class="cw-see-all">Ver todo</button>
            </div>
            <div class="cw-row" id="history-row"></div>
        `;

        const row = section.querySelector("#history-row");
        AppState.history.slice(0, 10).forEach((item, idx) => {
            const card = this.buildContinueCard(item);
            card.style.animationDelay = `${idx * 0.04}s`;
            row.appendChild(card);
        });

        section.querySelector(".cw-see-all").addEventListener("click", () => {
            Navigation.switchView("view-library");
        });

        container.innerHTML = "";
        container.appendChild(section);
    },
};

// ==================== HOME MANAGER ====================
const HomeManager = {
    async initializeSections(forceRefresh = false) {
        const content = $("home-content");
        if (forceRefresh) {
            content.innerHTML = "";
            AppState.homeSections.clear();
            AppState.homeInitialized = false;
            AppState.seenAnimeIds.clear();
            API.requestCache.clear();

            const topGenre = Recommendations.getTopGenre();
            const recCont = $("recommendations-container");
            if (topGenre && recCont) {
                const recConfig = {
                    id: "for_you",
                    title: "Recomendado Para Ti",
                    type: "genre",
                    endpoint: `genre/${topGenre}`,
                };
                recCont.innerHTML = "";
                const sec = this.createSectionElement(recConfig);
                recCont.appendChild(sec);
                AppState.homeSections.set(recConfig.id, {
                    config: recConfig,
                    element: sec,
                    loaded: false,
                    data: [],
                });
            }
        }

        if (AppState.homeInitialized) return;

        for (const config of SECTIONS_CONFIG) {
            const section = this.createSectionElement(config);
            content.appendChild(section);
            AppState.homeSections.set(config.id, {
                config,
                element: section,
                loaded: false,
                data: [],
                displayedCount: 0,
            });
            AppState.sectionPageCache.set(
                config.id,
                forceRefresh ? Math.floor(Math.random() * 3) + 1 : 1,
            );
        }

        AppState.homeInitialized = true;
        this.setupIntersectionObserver();
        await this.loadInitialSections(forceRefresh);
    },

    forceRefresh() {
        showToast("Actualizando catálogo...");
        const loader = $("home-loader");
        if (loader) loader.style.display = "flex";
        this.initializeSections(true);
    },

    createSectionElement(config) {
        const section = document.createElement("div");
        section.className = "home-section";
        section.id = `section-${config.id}`;
        section.innerHTML = `
            <div class="home-section-header">
                <h2 class="home-section-title">${config.title}</h2>
                <button class="btn-see-more">Ver más</button>
            </div>
            <div class="row-scroll" id="row-${config.id}"></div>
        `;

        const btn = section.querySelector(".btn-see-more");
        btn.addEventListener("click", () => {
            CategoryManager.open(config);
        });

        return section;
    },

    setupIntersectionObserver() {
        const rootEl = $("home-scroll");
        const sentinel = $("home-sentinel");

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && !AppState.homeLoading) {
                        this.loadNextSections();
                    }
                });
            },
            {
                root: rootEl,
                rootMargin: "300px 0px 300px 0px",
            },
        );

        if (sentinel) {
            observer.observe(sentinel);
        }
    },

    async loadInitialSections(nocache = false) {
        const unloaded = Array.from(AppState.homeSections.values())
            .filter((s) => !s.loaded)
            .slice(0, 3);

        if (unloaded.length === 0) {
            const loader = $("home-loader");
            if (loader) loader.style.display = "none";
            return;
        }

        AppState.homeLoading = true;
        const promises = unloaded.map((section) =>
            this.loadSection(section.config.id, nocache),
        );
        await Promise.allSettled(promises);

        const loader = $("home-loader");
        if (loader) loader.style.display = "none";
        AppState.homeLoading = false;
    },

    async loadNextSections() {
        const unloaded = Array.from(AppState.homeSections.values()).filter(
            (s) => !s.loaded,
        );

        if (unloaded.length === 0) {
            const loader = $("home-loader");
            if (loader) loader.style.display = "none";
            return;
        }

        AppState.homeLoading = true;
        const batchSize = 2;
        const batch = unloaded.slice(0, batchSize);
        const promises = batch.map((section) =>
            this.loadSection(section.config.id),
        );

        await Promise.allSettled(promises);
        AppState.homeLoading = false;

        const stillUnloaded = Array.from(AppState.homeSections.values()).filter(
            (s) => !s.loaded,
        );
        if (stillUnloaded.length > 0) {
            this.loadNextSections();
        }
    },

    async loadSection(sectionId, nocache = false) {
        const section = AppState.homeSections.get(sectionId);
        if (!section) return;

        if (AppState.sectionsLoading.has(sectionId)) return;
        AppState.sectionsLoading.add(sectionId);

        try {
            const { config } = section;
            let data;

            if (config.type === "latest") {
                const page = AppState.sectionPageCache.get(sectionId) || 1;
                data = await API.getLatest(page, nocache);
                AppState.sectionPageCache.set(sectionId, (page % 5) + 1);
            } else if (config.type === "trending") {
                data = await API.getTrending(nocache);
            } else if (config.type === "genre") {
                const genre = config.endpoint.split("/")[1];
                const page = AppState.sectionPageCache.get(sectionId) || 1;
                data = await API.getGenre(genre, page, nocache);
                AppState.sectionPageCache.set(sectionId, (page % 3) + 1);
            }

            section.loaded = true;

            if (data && data.success && data.data && data.data.length > 0) {
                // Add to AI Catalog
                AIManager.addToCatalog(data.data);

                let displayData = nocache
                    ? shuffleArray([...data.data])
                    : data.data;

                section.data = displayData;
                const row = $(`row-${sectionId}`);
                if (row) {
                    row.innerHTML = "";
                    const filteredItems = [];
                    for (const item of displayData) {
                        if (
                            !AppState.seenAnimeIds.has(item.id) &&
                            filteredItems.length < 15
                        ) {
                            AppState.seenAnimeIds.add(item.id);
                            filteredItems.push(item);
                        }
                    }

                    const itemsToRender = filteredItems.length > 0
                        ? filteredItems
                        : displayData.slice(0, 15);

                    itemsToRender.forEach((item, idx) => {
                        const card = UIBuilder.buildCard(item);
                        card.style.animationDelay = `${idx * 0.05}s`;
                        row.appendChild(card);
                    });
                }
            } else {
                if (section.element) section.element.style.display = "none";
            }
        } catch (err) {
            console.error("[HomeManager] Error cargando sección:", err);
            section.loaded = true;
            if (section.element) section.element.style.display = "none";
        } finally {
            AppState.sectionsLoading.delete(sectionId);
        }
    },

    getPersonalizedItems() {
        const items = [];
        AppState.homeSections.forEach((s) => items.push(...s.data));
        return items;
    },

    renderPersonalizedSection() {
        const container = $("recommendations-container");
        if (!container) return;

        // Obtenemos una muestra de todos los animes cargados en el Home
        const allItems = [];
        const seen = new Set();

        AppState.homeSections.forEach((section) => {
            if (section.data) {
                section.data.forEach((item) => {
                    if (!seen.has(item.id)) {
                        allItems.push(item);
                        seen.add(item.id);
                    }
                });
            }
        });

        if (allItems.length === 0) return;

        // El motor de recomendaciones clasifica dinámicamente según el perfil del usuario
        const personalizedItems = Recommendations.getRanked(allItems, 10);

        const section = document.createElement("div");
        section.className = "home-section recommendation-panel";
        section.innerHTML = `
            <div class="home-section-header">
                <div class="section-title-block">
                    <h2 class="home-section-title">Algoritmo SAO: Para ti</h2>
                    <span class="section-subtitle">Ajustado a tus gustos dinámicos</span>
                </div>
                <button class="btn-refresh-icon" id="btn-refresh-home" title="Actualizar">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                </button>
            </div>
            <div class="row-scroll" id="personalized-row"></div>
        `;

        const row = section.querySelector("#personalized-row");
        personalizedItems.forEach((item, idx) => {
            const card = UIBuilder.buildCard(item);
            card.style.animationDelay = `${idx * 0.04}s`;
            row.appendChild(card);
        });

        section
            .querySelector("#btn-refresh-home")
            .addEventListener("click", () => {
                HomeManager.forceRefresh();
            });

        container.innerHTML = "";
        container.appendChild(section);
    },

    bindFilterChips() {
        document.querySelectorAll("[data-home-filter]").forEach((btn) => {
            btn.addEventListener("click", () => {
                document
                    .querySelectorAll("[data-home-filter]")
                    .forEach((n) => n.classList.remove("active"));
                btn.classList.add("active");
                const filter = btn.dataset.homeFilter;
                if (filter === "recommended") {
                    $("recommendations-container")?.scrollIntoView({
                        behavior: "smooth",
                    });
                } else {
                    $(`section-${filter}`)?.scrollIntoView({
                        behavior: "smooth",
                    });
                }
            });
        });
    },
};

// ==================== CATEGORY MANAGER ====================
const CategoryManager = {
    open(config) {
        AppState.categoryType = config.type;
        AppState.categoryGenre =
            config.type === "genre" ? config.endpoint.split("/")[1] : null;
        AppState.categoryPage = 1;
        AppState.categoryHasMore = true;

        $("category-title").textContent = config.title;
        $("category-grid").innerHTML = "";

        Navigation.switchView("view-category");
        this.loadMore();
    },

    async loadMore() {
        if (AppState.categoryLoading || !AppState.categoryHasMore) return;

        AppState.categoryLoading = true;
        const loader = $("category-loader");
        if (loader) loader.style.display = "flex";

        try {
            let data;
            if (AppState.categoryType === "latest") {
                data = await API.getLatest(AppState.categoryPage);
            } else if (AppState.categoryType === "trending") {
                data = await API.getTrending();
                AppState.categoryHasMore = false;
            } else if (
                AppState.categoryType === "genre" &&
                AppState.categoryGenre
            ) {
                data = await API.getGenre(
                    AppState.categoryGenre,
                    AppState.categoryPage,
                );
            } else {
                data = { success: false, data: [] };
            }

            if (data.success && data.data && data.data.length > 0) {
                // Add to AI Catalog
                AIManager.addToCatalog(data.data);

                const grid = $("category-grid");
                data.data.forEach((item, idx) => {
                    const card = UIBuilder.buildCard(item);
                    card.style.animationDelay = `${(idx % 20) * 0.05}s`;
                    grid.appendChild(card);
                });

                AppState.categoryPage++;
                if (data.data.length < 20) {
                    AppState.categoryHasMore = false;
                }
            } else {
                AppState.categoryHasMore = false;
            }
        } catch (err) {
            console.error("[CategoryManager] Error cargando más:", err);
            showToast("Error al cargar más");
            AppState.categoryHasMore = false;
        } finally {
            AppState.categoryLoading = false;
            if (loader) {
                loader.style.display = AppState.categoryHasMore
                    ? "flex"
                    : "none";
            }
        }
    },

    setupScroll() {
        const scrollEl = $("category-scroll");
        const sentinel = $("category-sentinel");

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (
                        entry.isIntersecting &&
                        !AppState.categoryLoading &&
                        AppState.categoryHasMore
                    ) {
                        this.loadMore();
                    }
                });
            },
            { root: scrollEl, rootMargin: "0px 0px 300px 0px" },
        );

        if (sentinel) {
            observer.observe(sentinel);
        }
    },
};

// ==================== DETAIL OVERLAY ====================
const DetailOverlay = {
    setup() {
        const btnSort = $("btn-sort-ep");
        if (btnSort) {
            btnSort.onclick = () => {
                AppState.episodeSortOrder *= -1;
                btnSort.classList.toggle(
                    "active",
                    AppState.episodeSortOrder === -1,
                );
                this.renderEpisodeGrid();
            };
        }
    },

    resetVisuals() {
        const titleEl = $("detail-title");
        const coverEl = $("detail-cover");
        const backdropEl = $("detail-backdrop-fixed");
        const synopsisEl = $("detail-synopsis");
        const statusEl = $("detail-status");
        const epCountEl = $("detail-ep-count");
        const genresCont = $("detail-genres");
        const episodesCont = $("detail-episodes");
        const rangesCont = $("ep-ranges-container");

        if (titleEl) titleEl.textContent = "Cargando...";
        if (coverEl)
            coverEl.src =
                "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
        if (backdropEl) backdropEl.style.backgroundImage = "none";
        if (synopsisEl) synopsisEl.textContent = "";
        if (statusEl) statusEl.textContent = "...";
        if (epCountEl) epCountEl.textContent = "0";
        if (genresCont) genresCont.innerHTML = "";
        if (episodesCont) episodesCont.innerHTML = "";
        if (rangesCont) rangesCont.innerHTML = "";

        const btn = $("btn-library");
        if (btn) btn.classList.remove("active");

        const btnSort = $("btn-sort-ep");
        if (btnSort) btnSort.classList.remove("active");

        AppState.episodeSortOrder = 1;
        AppState.currentEpisodePage = 0;
    },

    async open(animeId) {
        const overlay = $("overlay-detail");
        overlay.classList.add("active");

        this.resetVisuals();

        const loading = $("detail-loading");
        const loaded = $("detail-loaded");
        if (loading) loading.style.display = "flex";
        if (loaded) {
            loaded.style.display = "none";
            loaded.style.opacity = "0";
        }

        try {
            const data = await API.getInfo(animeId);
            if (!data.success || !data.data) {
                throw new Error(data.error || "No se encontró el anime");
            }

            const anime = data.data;
            AppState.currentAnime = anime;

            Recommendations.track("view", anime);

            if (loading) loading.style.display = "none";
            if (loaded) {
                loaded.style.display = "block";
                loaded.style.opacity = "1";
            }
            this.render(anime);
        } catch (err) {
            console.error("[DetailOverlay] Error:", err);
            showToast("Anime no encontrado");
            this.close();
        }
    },

    render(anime) {
        const titleEl = $("detail-title");
        const coverEl = $("detail-cover");
        const backdropEl = $("detail-backdrop-fixed");
        const synopsisEl = $("detail-synopsis");
        const statusEl = $("detail-status");
        const epCountEl = $("detail-ep-count");

        if (titleEl) titleEl.textContent = anime.title || "Animé";
        if (coverEl) {
            coverEl.src =
                anime.cover ||
                "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
        }
        if (backdropEl) {
            backdropEl.style.backgroundImage = anime.cover
                ? `url(${anime.cover})`
                : "none";
        }
        if (synopsisEl)
            synopsisEl.textContent =
                anime.synopsis || "Sin sinopsis disponible";
        if (statusEl) statusEl.textContent = anime.status || "Desconocido";
        if (epCountEl)
            epCountEl.textContent =
                anime.episodes && anime.episodes.length
                    ? anime.episodes.length
                    : 0;

        const genresCont = $("detail-genres");
        if (genresCont) {
            genresCont.innerHTML = "";
            (anime.genres || []).forEach((g, idx) => {
                const span = document.createElement("span");
                span.textContent = g;
                span.style.animationDelay = `${idx * 0.05}s`;
                genresCont.appendChild(span);
            });
        }

        AppState.currentEpisodePage = 0;
        this.renderEpisodeRanges(anime);
        this.renderEpisodeGrid();

        this.updateLibraryBtn();
        this.renderSimilar(anime);
    },

    renderEpisodeRanges(anime) {
        const container = $("ep-ranges-container");
        if (!container) return;
        container.innerHTML = "";

        // IMPORTANTE: Ordenar episodios numéricamente antes de calcular rangos
        const eps = [...(anime.episodes || [])].sort(
            (a, b) => Number(a.number) - Number(b.number),
        );

        if (eps.length <= AppState.episodePageSize) {
            container.style.display = "none";
            return;
        }

        container.style.display = "flex";
        const pageCount = Math.ceil(eps.length / AppState.episodePageSize);

        for (let i = 0; i < pageCount; i++) {
            // Calculamos el número real de los capítulos basándonos en la lista ordenada
            const startEp = eps[i * AppState.episodePageSize].number;
            const lastIdx = Math.min(
                (i + 1) * AppState.episodePageSize - 1,
                eps.length - 1,
            );
            const endEp = eps[lastIdx].number;

            const chip = document.createElement("button");
            chip.className = `ep-range-chip ${i === AppState.currentEpisodePage ? "active" : ""}`;
            chip.textContent = `${startEp}-${endEp}`;
            chip.onclick = () => {
                if (AppState.currentEpisodePage === i) return;
                AppState.currentEpisodePage = i;
                container
                    .querySelectorAll(".ep-range-chip")
                    .forEach((c) => c.classList.remove("active"));
                chip.classList.add("active");
                this.renderEpisodeGrid();
            };
            container.appendChild(chip);
        }
    },

    renderEpisodeGrid() {
        const episodesCont = $("detail-episodes");
        const anime = AppState.currentAnime;
        if (!episodesCont || !anime) return;

        episodesCont.innerHTML = "";

        const rawEps = anime.episodes || [];
        if (rawEps.length === 0) {
            const msg = document.createElement("div");
            msg.className = "empty-state-premium";
            msg.textContent = "No se encontraron episodios.";
            episodesCont.appendChild(msg);
            return;
        }

        // 1. Siempre ordenar de forma ascendente primero para que los rangos sean consistentes
        let sortedEps = [...rawEps].sort(
            (a, b) => Number(a.number) - Number(b.number),
        );

        // 2. Aplicar paginación sobre la lista ordenada
        const start = AppState.currentEpisodePage * AppState.episodePageSize;
        let displayEps = sortedEps.slice(
            start,
            start + AppState.episodePageSize,
        );

        // 3. Aplicar orden visual del usuario (Invertir si es DESC)
        if (AppState.episodeSortOrder === -1) {
            displayEps.reverse();
        }

        const historyItem = AppState.history.find((h) => h.id === anime.id);

        displayEps.forEach((ep, idx) => {
            const row = document.createElement("div");
            row.className = "ep-row";
            row.style.animationDelay = `${Math.min(idx * 0.02, 0.3)}s`;

            const isWatched =
                historyItem &&
                historyItem.watched &&
                historyItem.watched.includes(ep.number);
            const epProgress =
                historyItem && historyItem.progressMap
                    ? historyItem.progressMap[ep.number] || 0
                    : 0;

            const watchTag =
                isWatched && epProgress >= 90
                    ? '<span class="ep-status-tag watched">Visto</span>'
                    : epProgress > 0
                      ? `<span class="ep-status-tag">En curso ${Math.round(epProgress)}%</span>`
                      : "";

            row.innerHTML = `
                <div class="ep-row-content">
                    <span class="ep-number" style="font-weight: 600;">Episodio ${ep.number}</span>
                    ${watchTag}
                </div>
                <div class="ep-row-icon">
                   <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>
                </div>
            `;
            row.onclick = () => {
                PlayerOverlay.open(ep.number);
            };
            episodesCont.appendChild(row);
        });
    },

    renderSimilar(anime) {
        const parent = $("detail-loaded");
        if (!parent) return;

        // Limpiar sección anterior si existe
        const existingRec = parent.querySelector(".similar-section");
        if (existingRec) existingRec.remove();

        const allLoaded = [];
        AppState.homeSections.forEach((s) => allLoaded.push(...s.data));

        const similar = Recommendations.getSimilar(anime, allLoaded, 8);
        if (similar.length === 0) return;

        const container = document.createElement("div");
        container.className = "similar-section";
        container.innerHTML = `
            <div class="similar-header" style="margin: 20px 0 12px; padding: 0 4px;">
                <h3 style="font-size: 1.1rem; font-weight: 700; color: #fff;">Animes Similares</h3>
                <p style="font-size: 0.8rem; color: var(--text-soft); margin-top: 2px;">Para expandir tus gustos</p>
            </div>
            <div class="row-scroll" id="similar-row"></div>
        `;

        const row = container.querySelector("#similar-row");
        similar.forEach((item, idx) => {
            const card = UIBuilder.buildCard(item);
            card.style.animationDelay = `${idx * 0.05}s`;
            row.appendChild(card);
        });

        parent.appendChild(container);
    },

    updateLibraryBtn() {
        const btn = $("btn-library");
        if (!AppState.currentAnime || !btn) return;
        const isSaved = AppState.library.some(
            (a) => a.id === AppState.currentAnime.id,
        );

        if (isSaved) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    },

    close() {
        const overlay = $("overlay-detail");
        if (!overlay) return;
        // Add closing class for animated exit, then remove active after transition
        overlay.classList.add("closing");
        setTimeout(() => {
            overlay.classList.remove("active");
            overlay.classList.remove("closing");
        }, 300);
    },
};

// ==================== PLAYER OVERLAY ====================
const PlayerOverlay = {
    retryCount: 0,
    maxRetries: 3,
    cinemaMode: false,
    peekTimer: null,
    _shieldTimer: null,
    // ── Super-shield state ─────────────────────────────────────────────
    _superShieldActive: false,
    _superTimer:        null,
    _releaseTimer:      null,
    _releaseHandler:    null,
    _historyHeartbeat:  null,
    _hintTimer:         null,
    _isPlaying:         false,
    _ctrlHandlers:      null,
    _activeServerUrl:   '',
    _allowedLoads:      0,
    // ──────────────────────────────────────────────────────────────────

    enterCinema() {
        const overlay = $("overlay-player");
        if (!overlay) return;
        this.cinemaMode = true;
        overlay.classList.add("player-cinema");

        // Best-effort native fullscreen (works on Android Chrome)
        try {
            if (overlay.requestFullscreen) overlay.requestFullscreen().catch(() => {});
            else if (overlay.webkitRequestFullscreen) overlay.webkitRequestFullscreen();
        } catch (_) {}

        // Best-effort landscape lock (works in installed PWA / Android)
        try {
            if (screen.orientation && screen.orientation.lock) {
                screen.orientation.lock("landscape").catch(() => {});
            }
        } catch (_) {}

        this._injectPeekBar();
        this._showPeek(2800);
        this._showTapHint();

        // Swap icon to compress/exit
        const btn = $("btn-fullscreen-player");
        if (btn) btn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>`;
    },

    exitCinema() {
        this.cinemaMode = false;
        const overlay = $("overlay-player");
        if (overlay) overlay.classList.remove("player-cinema");

        try {
            if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
        } catch (_) {}

        try {
            if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
        } catch (_) {}

        if (this.peekTimer) { clearTimeout(this.peekTimer); this.peekTimer = null; }
        const peek = $("player-cinema-peek");
        if (peek) peek.classList.remove("show");

        // Restore expand icon
        const btn = $("btn-fullscreen-player");
        if (btn) btn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>`;
    },

    _injectPeekBar() {
        if ($("player-cinema-peek")) {
            // Update title/ep in case episode changed
            const t = $("cinema-peek-title"), e = $("cinema-peek-ep");
            if (t) t.textContent = $("player-title")?.textContent || "";
            if (e) e.textContent = $("player-episode-info")?.textContent || "";
            return;
        }
        const wrapper = document.querySelector(".player-container-wrapper");
        if (!wrapper) return;

        const peek = document.createElement("div");
        peek.id = "player-cinema-peek";
        peek.className = "player-cinema-peek";
        peek.innerHTML = `
            <button class="btn-cinema-exit" id="btn-cinema-exit" aria-label="Salir de pantalla completa">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>
            </button>
            <div class="cinema-peek-info">
                <span class="cinema-peek-title" id="cinema-peek-title"></span>
                <span class="cinema-peek-ep" id="cinema-peek-ep"></span>
            </div>
            <button class="btn-cinema-nav" id="cinema-btn-prev" aria-label="Episodio anterior">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 19l-7-7 7-7"></path></svg>
            </button>
            <button class="btn-cinema-nav" id="cinema-btn-next" aria-label="Episodio siguiente">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 5l7 7-7 7"></path></svg>
            </button>
        `;
        wrapper.appendChild(peek);

        const t = $("cinema-peek-title"), e = $("cinema-peek-ep");
        if (t) t.textContent = $("player-title")?.textContent || "";
        if (e) e.textContent = $("player-episode-info")?.textContent || "";

        $("btn-cinema-exit").addEventListener("click", (ev) => {
            ev.stopPropagation();
            PlayerOverlay.exitCinema();
        });
        $("cinema-btn-prev").addEventListener("click", (ev) => {
            ev.stopPropagation();
            $("btn-prev-ep")?.click();
        });
        $("cinema-btn-next").addEventListener("click", (ev) => {
            ev.stopPropagation();
            $("btn-next-ep")?.click();
        });

        // Tap anywhere on the player wrapper to reveal controls
        wrapper.addEventListener("click", () => {
            if (PlayerOverlay.cinemaMode) PlayerOverlay._showPeek(3200);
        });
    },

    _showPeek(duration = 3200) {
        const peek = $("player-cinema-peek");
        if (!peek) return;
        peek.classList.add("show");
        if (this.peekTimer) clearTimeout(this.peekTimer);
        this.peekTimer = setTimeout(() => peek.classList.remove("show"), duration);
    },

    // ── Anti-redirect: Short shield (blur re-activation, etc.) ────────
    _activateShield(ms = 1800) {
        if (this._superShieldActive) return; // super-shield has priority
        const shield = $("player-shield");
        if (!shield) return;
        shield.classList.add("active");
        if (this._shieldTimer) clearTimeout(this._shieldTimer);
        this._shieldTimer = setTimeout(() => {
            shield.classList.remove("active");
        }, ms);
    },

    _deactivateShield() {
        if (this._shieldTimer) { clearTimeout(this._shieldTimer); this._shieldTimer = null; }
        const shield = $("player-shield");
        if (shield) shield.classList.remove("active");
    },

    // ── Super-shield: 60 seconds of continuous protection ──────────────
    // Each user tap briefly opens the shield (120 ms quick-release) so the
    // video player can receive the touch — but ANY follow-up tap is absorbed
    // before ad scripts can count a "second click" for their redirect pattern.
    // History heartbeat + iframe-redirect detection run in parallel.
    _startSuperShield() {
        this._stopSuperShield(); // clear any previous instance
        this._deactivateShield();

        const shield = $("player-shield");
        if (!shield) return;

        this._superShieldActive = true;
        shield.classList.add("active", "super-active");

        // Hint visibility: show for 10 s on first encounter, then hide permanently
        // per anime+episode combination (stored in localStorage).
        const hintKey = `animesao_shieldhint_${AppState.currentAnime?.id}_${AppState.currentEpisode}`;
        if (localStorage.getItem(hintKey)) {
            shield.classList.add('shield-hint-hidden');
        } else {
            shield.classList.remove('shield-hint-hidden');
            if (this._hintTimer) clearTimeout(this._hintTimer);
            this._hintTimer = setTimeout(() => {
                shield.classList.add('shield-hint-hidden');
                localStorage.setItem(hintKey, '1');
            }, 10000);
        }

        // Quick-release: tap → pointer-events:none for 500 ms → re-close
        const onTap = () => {
            if (!this._superShieldActive) return;
            shield.style.pointerEvents = 'none';
            if (this._releaseTimer) clearTimeout(this._releaseTimer);
            this._releaseTimer = setTimeout(() => {
                if (this._superShieldActive) shield.style.pointerEvents = '';
            }, 500);
        };
        this._releaseHandler = onTap;
        shield.addEventListener('touchstart', onTap, { passive: true });
        shield.addEventListener('click', onTap);

        // History heartbeat: push a state every 2 s to swallow history.back()
        this._historyHeartbeat = setInterval(() => {
            if (this._superShieldActive) {
                history.pushState({ animesao: true, ts: Date.now() }, '', location.href);
            }
        }, 2000);

        // Auto-deactivate after 60 s
        this._superTimer = setTimeout(() => {
            this._stopSuperShield();
            showToast('🛡 Protección completada — ya puedes interactuar libremente');
        }, 60000);
    },

    _stopSuperShield() {
        this._superShieldActive = false;
        if (this._superTimer)       { clearTimeout(this._superTimer);       this._superTimer = null; }
        if (this._releaseTimer)     { clearTimeout(this._releaseTimer);      this._releaseTimer = null; }
        if (this._hintTimer)        { clearTimeout(this._hintTimer);         this._hintTimer = null; }
        if (this._historyHeartbeat) { clearInterval(this._historyHeartbeat); this._historyHeartbeat = null; }

        const shield = $("player-shield");
        if (shield) {
            if (this._releaseHandler) {
                shield.removeEventListener('touchstart', this._releaseHandler);
                shield.removeEventListener('click',      this._releaseHandler);
                this._releaseHandler = null;
            }
            shield.style.pointerEvents = '';
            shield.classList.remove("active", "super-active", "shield-hint-hidden");
        }
    },
    // ──────────────────────────────────────────────────────────────────

    _showTapHint() {
        const wrapper = document.querySelector(".player-container-wrapper");
        if (!wrapper) return;
        const old = wrapper.querySelector(".cinema-tap-hint");
        if (old) old.remove();
        const hint = document.createElement("div");
        hint.className = "cinema-tap-hint";
        hint.textContent = "Toca la pantalla para mostrar controles";
        wrapper.appendChild(hint);
        setTimeout(() => hint.remove(), 2800);
    },

    async open(epNumber) {
        if (!AppState.currentAnime) return;

        AppState.currentEpisode = epNumber;
        AppState.currentServerIndex = 0;
        this.retryCount = 0;

        const overlay = $("overlay-player");
        if (overlay) {
            overlay.classList.add("active");
            document.body.classList.add("player-active");
        }

        const titleEl = $("player-title");
        const episodeEl = $("player-episode-info");
        const iframeEl = $("player-iframe");

        if (titleEl) titleEl.textContent = AppState.currentAnime.title;
        if (episodeEl) episodeEl.textContent = `Episodio ${epNumber}`;
        if (iframeEl) iframeEl.src = "";

        const loader = $("player-loader");
        if (loader) loader.style.display = "flex";

        const error = $("player-error");
        if (error) error.classList.add("hidden");

        const serverSelector = $("server-selector");
        if (serverSelector) serverSelector.innerHTML = "";

        try {
            const data = await API.getVideo(AppState.currentAnime.id, epNumber);

            if (
                !data.success ||
                !data.data ||
                !data.data.servers ||
                data.data.servers.length === 0
            ) {
                throw new Error("No se encontraron servidores");
            }

            AppState.currentServers = data.data.servers;
            this.renderServers();
            this.loadServer(0);
            this.updateNavigation();
        } catch (err) {
            console.error("[PlayerOverlay] Error:", err);
            this.showError("No se pudo cargar el video");
            this.updateNavigation();
        }
    },

    renderServers() {
        const selector = $("server-selector");
        if (!selector) return;

        selector.innerHTML = "";
        AppState.currentServers.forEach((server, idx) => {
            const opt = document.createElement("option");
            opt.value = idx;
            opt.textContent = `${server.name || `Servidor ${idx + 1}`}`;
            selector.appendChild(opt);
        });
        selector.addEventListener("change", (e) => {
            this.loadServer(parseInt(e.target.value, 10));
        });
    },

    progressTimer: null,

    startProgressTracking() {
        if (this.progressTimer) clearInterval(this.progressTimer);

        let progress = 0;
        const historyItem = AppState.history.find(
            (h) => h.id === AppState.currentAnime.id,
        );
        if (
            historyItem &&
            historyItem.progressMap &&
            historyItem.progressMap[AppState.currentEpisode]
        ) {
            progress = historyItem.progressMap[AppState.currentEpisode];
        }

        this.progressTimer = setInterval(() => {
            if (progress < 98) {
                // Supongamos un episodio de 24 mins (1440s)
                // Cada 10s sumamos ~0.7%
                progress += 0.7;
                this.saveToHistory(
                    AppState.currentAnime,
                    AppState.currentEpisode,
                    progress,
                );
            } else if (progress >= 98 && progress < 100) {
                progress = 100;
                this.saveToHistory(
                    AppState.currentAnime,
                    AppState.currentEpisode,
                    100,
                );
            }
        }, 10000);
    },

    loadServer(index) {
        const server = AppState.currentServers[index];
        if (!server) return;

        AppState.currentServerIndex = index;
        const loader = $("player-loader");
        const error  = $("player-error");

        if (loader) loader.style.display = "none";
        if (error)  error.classList.add("hidden");

        const iframe = $("player-iframe");
        if (!iframe) return;

        // Track URL + allowed loads for iframe-redirect detection
        this._activeServerUrl = server.url;
        this._allowedLoads    = 3; // allow up to 3 loads (some players navigate internally)

        iframe.onload = () => {
            if (this._allowedLoads > 0) {
                this._allowedLoads--;
                if (AppState.currentAnime && AppState.currentEpisode) {
                    this.saveToHistory(AppState.currentAnime, AppState.currentEpisode);
                    this.startProgressTracking();
                }
            } else {
                // Unexpected load = ad script redirected the iframe itself
                showToast('🛡 Redirección interna detectada — reiniciando reproductor');
                this._allowedLoads = 2; // allow the reset + 1 internal
                iframe.src = this._activeServerUrl;
                this._startSuperShield();
            }
        };

        iframe.onerror = () => {
            if (this.retryCount < this.maxRetries - 1) {
                this.retryCount++;
                setTimeout(() => { this.loadServer(AppState.currentServerIndex); }, 1000);
            } else {
                this.showError("Servidor no disponible. Intenta otro.");
            }
        };

        iframe.src = server.url;

        // Start 60-second continuous super-shield
        this._startSuperShield();
    },

    showError(message) {
        const loader = $("player-loader");
        const error = $("player-error");

        if (loader) loader.style.display = "none";
        if (error) {
            error.classList.remove("hidden");
            const msgEl = error.querySelector(".error-message");
            if (msgEl) msgEl.textContent = message;
        }

        const btnRetry = $("btn-retry");
        if (btnRetry) {
            btnRetry.onclick = () => {
                this.retryCount = 0;
                this.loadServer(AppState.currentServerIndex);
            };
        }
    },

    updateNavigation() {
        const eps = AppState.currentAnime?.episodes || [];
        const canGoPrev = eps.some(
            (e) => e.number === AppState.currentEpisode - 1,
        );
        const canGoNext = eps.some(
            (e) => e.number === AppState.currentEpisode + 1,
        );

        const btnPrev = $("btn-prev-ep");
        const btnNext = $("btn-next-ep");

        if (btnPrev) {
            btnPrev.disabled = !canGoPrev;
            btnPrev.onclick = () => {
                if (canGoPrev) this.open(AppState.currentEpisode - 1);
            };
        }
        if (btnNext) {
            btnNext.disabled = !canGoNext;
            btnNext.onclick = () => {
                if (canGoNext) this.open(AppState.currentEpisode + 1);
            };
        }
    },

    saveToHistory(anime, episode, progress = 0) {
        const now = Date.now();
        const existingIndex = AppState.history.findIndex(
            (h) => h.id === anime.id,
        );

        let historyItem;
        if (existingIndex > -1) {
            // Preservar datos existentes (como episodios ya vistos)
            historyItem = AppState.history[existingIndex];
            historyItem.lastEp = episode;
            historyItem.lastUpdated = now;
            historyItem.timestamp = now; // Mover al principio

            if (!historyItem.watched) historyItem.watched = [];
            if (!historyItem.watched.includes(episode)) {
                historyItem.watched.push(episode);
            }

            if (!historyItem.progressMap) historyItem.progressMap = {};
            // Solo actualizamos si el progreso es mayor o si es un episodio nuevo
            if (progress > (historyItem.progressMap[episode] || 0)) {
                historyItem.progressMap[episode] = progress;
            }

            AppState.history.splice(existingIndex, 1);
        } else {
            historyItem = {
                id: anime.id,
                title: anime.title,
                cover: anime.cover,
                lastEp: episode,
                watched: [episode],
                progressMap: { [episode]: progress },
                timestamp: now,
                lastUpdated: now,
            };
        }

        AppState.history.unshift(historyItem);
        AppState.history = AppState.history.slice(0, 100);

        localStorage.setItem("anime_history", JSON.stringify(AppState.history));
        UIBuilder.renderHistorySection();
        Recommendations.registerEpisodeWatch(anime);

        // Sync library status
        const libItem = AppState.library.find(a => a.id === anime.id);
        if (libItem) {
            const eps = AppState.currentAnime?.episodes || [];
            const isLastEp = eps.length > 0 && !eps.some(e => e.number === episode + 1);
            if (isLastEp && progress >= 85 && libItem.status !== "completed") {
                libItem.status = "completed";
                localStorage.setItem("anime_library", JSON.stringify(AppState.library));
                showToast("¡Anime completado! Marcado automáticamente");
            } else if (libItem.status === "pending") {
                libItem.status = "progress";
                localStorage.setItem("anime_library", JSON.stringify(AppState.library));
            }
        }
    },

    updateActiveProgress(percent) {
        if (!AppState.currentAnime || !AppState.currentEpisode) return;
        this.saveToHistory(
            AppState.currentAnime,
            AppState.currentEpisode,
            percent,
        );
    },

    close() {
        // Always clean up cinema mode + all shields first
        if (this.cinemaMode) this.exitCinema();
        this._stopSuperShield();
        this._deactivateShield();

        const overlay = $("overlay-player");
        const iframe = $("player-iframe");

        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }

        if (overlay) {
            overlay.classList.remove("active");
            document.body.classList.remove("player-active");
        }
        if (iframe) iframe.src = "";
    },
};

// ==================== SEARCH ====================
const Search = {
    reset() {
        const input = $("search-input");
        const grid = $("search-grid");
        const message = $("search-message");
        const clear = $("search-clear");

        if (input) input.value = "";
        if (clear) clear.classList.add("hidden");
        if (grid) grid.innerHTML = "";
        if (message) {
            message.style.display = "flex";
            message.style.animation = "fadeInUp 0.5s ease-out forwards";
        }
        this.renderDiscoverGenres();
    },

    setup() {
        const input = $("search-input");
        const clear = $("search-clear");
        const message = $("search-message");
        const grid = $("search-grid");
        const suggestionsBox = $("search-suggestions");

        if (!input) return;

        // Mostrar géneros al inicio
        this.renderDiscoverGenres();

        input.addEventListener(
            "input",
            debounce(async (e) => {
                const q = e.target.value.trim();

                if (clear) clear.classList.toggle("hidden", q.length === 0);

                if (q.length < 2) {
                    if (suggestionsBox) suggestionsBox.classList.add("hidden");
                    if (q.length === 0) {
                        if (grid) grid.innerHTML = "";
                        if (message) {
                            message.style.display = "flex";
                            this.renderDiscoverGenres();
                        }
                    }
                    return;
                }

                this.showSuggestions(q);
            }, 300),
        );

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                const q = input.value.trim();
                if (q.length >= 2) {
                    if (suggestionsBox) suggestionsBox.classList.add("hidden");
                    this.execute(q);
                }
            }
        });

        document.addEventListener("click", (e) => {
            if (
                suggestionsBox &&
                !suggestionsBox.contains(e.target) &&
                e.target !== input
            ) {
                suggestionsBox.classList.add("hidden");
            }
        });

        document.addEventListener("touchstart", (e) => {
            if (
                suggestionsBox &&
                !suggestionsBox.contains(e.target) &&
                e.target !== input
            ) {
                suggestionsBox.classList.add("hidden");
            }
        }, { passive: true });

        document.addEventListener("scroll", () => {
            if (suggestionsBox) suggestionsBox.classList.add("hidden");
        }, { passive: true, capture: true });

        if (clear) {
            clear.addEventListener("click", () => {
                input.value = "";
                if (grid) grid.innerHTML = "";
                clear.classList.add("hidden");
                if (message) {
                    message.style.display = "flex";
                    this.renderDiscoverGenres();
                }
                if (suggestionsBox) suggestionsBox.classList.add("hidden");
            });
        }
    },

    _genresRendered: false,

    renderDiscoverGenres() {
        const container = $("discover-genres");
        if (!container) return;
        if (this._genresRendered && container.childElementCount > 0) return;
        this._genresRendered = true;

        const relevantGenres = [
            "Películas",
            "Acción",
            "Aventuras",
            "Ciencia Ficción",
            "Comedia",
            "Deportes",
            "Drama",
            "Fantasía",
            "Magia",
            "Misterio",
            "Psicológico",
            "Romance",
            "Shounen",
            "Seinen",
            "Terror",
            "Sobrenatural",
        ];

        container.innerHTML = "";
        relevantGenres.forEach((genre, idx) => {
            const chip = document.createElement("div");
            chip.className = "genre-chip";
            chip.textContent = genre;
            chip.setAttribute("data-genre", genre);
            chip.style.animation = `fadeInUp 0.4s ease-out forwards`;
            chip.style.animationDelay = `${idx * 0.04}s`;
            chip.onclick = (e) => {
                e.stopPropagation();
                this.execute(genre, { isGenre: true });
            };
            container.appendChild(chip);
        });
    },

    async showSuggestions(query) {
        const suggestionsBox = $("search-suggestions");
        if (!suggestionsBox) return;

        try {
            const data = await API.search(query);
            if (data.success && data.data && data.data.length > 0) {
                const limited = data.data.slice(0, 6);
                suggestionsBox.innerHTML = "";
                limited.forEach((anime) => {
                    const item = document.createElement("div");
                    item.className = "suggestion-item";
                    item.innerHTML = `
                        <img src="${anime.cover}" class="suggestion-cover" onerror="this.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='">
                        <div class="suggestion-info">
                            <span class="suggestion-title">${anime.title}</span>
                            <span class="suggestion-meta">${anime.status || "Anime"}</span>
                        </div>
                    `;
                    item.addEventListener("click", () => {
                        suggestionsBox.classList.add("hidden");
                        const input = $("search-input");
                        if (input) input.value = anime.title;
                        DetailOverlay.open(anime.id);
                    });
                    suggestionsBox.appendChild(item);
                });
                suggestionsBox.classList.remove("hidden");
            } else {
                suggestionsBox.classList.add("hidden");
            }
        } catch (err) {
            console.error("[Search] Suggestion Error:", err);
            suggestionsBox.classList.add("hidden");
        }
    },

    async execute(query, options = {}) {
        const message = $("search-message");
        const grid = $("search-grid");
        const loader = $("search-loader");
        const suggestionsBox = $("search-suggestions");
        const input = $("search-input");

        if (suggestionsBox) suggestionsBox.classList.add("hidden");
        if (message) message.style.display = "none";

        // Limpiamos resultados previos
        if (grid) grid.innerHTML = "";
        if (loader) loader.classList.remove("hidden");

        // Si es búsqueda por género, podemos limpiar el input o dejarlo
        if (options.isGenre && input) {
            input.value = "";
            const clear = $("search-clear");
            if (clear) clear.classList.add("hidden");
        }

        try {
            let data;
            if (options.isGenre) {
                // Mapeo de nombres a slugs específicos de la API
                const genreMappings = {
                    peliculas: "pelicula",
                    aventuras: "aventura",
                    "ciencia-ficcion": "ciencia-ficcion",
                    "recuentos-de-la-vida": "recuentos-de-la-vida",
                    lovecraft: "lovecraft",
                };

                let genreSlug = query
                    .toLowerCase()
                    .normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "") // Quitar acentos
                    .replace(/\s+/g, "-"); // Espacios por guiones

                // Aplicar mapeo manual si existe
                if (genreMappings[genreSlug]) {
                    genreSlug = genreMappings[genreSlug];
                }

                // Si es películas, intentamos una búsqueda más amplia o filtrada
                if (query === "Películas") {
                    // Primero intentamos con "movie" que suele ser más efectivo
                    data = await API.search("movie");

                    // Si hay pocos resultados, intentamos con "pelicula"
                    if (!data.success || !data.data || data.data.length < 5) {
                        const fallbackData = await API.search("pelicula");
                        if (
                            fallbackData.success &&
                            fallbackData.data.length > 0
                        ) {
                            if (!data.data) data.data = [];
                            // Combinamos y evitamos duplicados
                            const existingIds = new Set(
                                data.data.map((i) => i.id),
                            );
                            fallbackData.data.forEach((item) => {
                                if (!existingIds.has(item.id))
                                    data.data.push(item);
                            });
                            data.success = true;
                        }
                    }

                    // Filtramos por episodios (1) o tipo
                    if (data.success && data.data) {
                        data.data = data.data.filter((anime) => {
                            return (
                                anime.episodes === 1 ||
                                (anime.type &&
                                    anime.type
                                        .toLowerCase()
                                        .includes("movie")) ||
                                (anime.title &&
                                    anime.title.toLowerCase().includes("movie"))
                            );
                        });
                    }
                } else {
                    data = await API.getGenre(genreSlug);
                }
            } else {
                data = await API.search(query);
            }

            if (loader) loader.classList.add("hidden");

            if (!data.success || !data.data || data.data.length === 0) {
                if (message) {
                    const p = message.querySelector("p");
                    if (p)
                        p.textContent =
                            'No se encontraron resultados para "' + query + '"';
                    message.style.display = "flex";
                    this.renderDiscoverGenres();
                }
            } else {
                // Add to AI Catalog
                AIManager.addToCatalog(data.data);

                if (grid) {
                    grid.innerHTML = "";

                    if (options.isGenre) {
                        const header = document.createElement("div");
                        header.className = "genre-results-header";
                        header.innerHTML = `
                            <div class="genre-header-info">
                                <div class="genre-tag-active">
                                    <span style="color: var(--text-secondary); font-size: 14px; display: block; margin-bottom: 4px; font-weight: 500;">Búsqueda por género</span>
                                    ${query}
                                </div>
                                <div class="genre-results-count">${data.data.length} Animes</div>
                            </div>
                            <button class="btn-genre-reset">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                                Volver al explorador
                            </button>
                        `;
                        header.querySelector(".btn-genre-reset").onclick =
                            () => {
                                grid.innerHTML = "";
                                message.style.display = "flex";
                                message.style.animation =
                                    "fadeInUp 0.4s ease-out";
                                this._genresRendered = false;
                                this.renderDiscoverGenres();
                            };
                        grid.appendChild(header);
                    }

                    data.data.forEach((item, idx) => {
                        const card = UIBuilder.buildCard(item);
                        card.style.animationDelay = `${idx * 0.05}s`;
                        grid.appendChild(card);
                    });
                }
            }
        } catch (err) {
            console.error("[Search] Error:", err);
            if (loader) loader.classList.add("hidden");
            showToast("Error en la búsqueda");
        }
    },
};

// ==================== AI MANAGER v4 ====================
const AIManager = {
    CONV_KEY: "anibot_conv_v4",
    _queue: [],
    _processing: false,
    _currentMood: "curious",

    _svgBot: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="white" stroke-width="1.8"><path d="M12 2a5 5 0 0 1 5 5v1h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5z"/><circle cx="9" cy="13" r="1.1" fill="white" stroke="none"/><circle cx="15" cy="13" r="1.1" fill="white" stroke="none"/></svg>`,
    _svgUser: `<svg viewBox="0 0 24 24" width="13" height="13" stroke="rgba(255,255,255,0.7)" stroke-width="2" fill="none"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`,

    // ---- Init & Status ----
    init() {
        AppState.apiKey = localStorage.getItem("gemini_api_key") || "";
        this.updateStatus(AppState.apiKey ? "online" : "offline", AppState.apiKey ? "Online" : "Sin API Key");
        const container = $("ai-chat-container");
        if (container && !container.children.length) {
            container.innerHTML = this._welcomeHTML();
            this._rebindQuickChips();
        }
        this.loadConversation();
    },

    updateStatus(status, text) {
        const dot = $("ai-status-dot") || document.querySelector(".status-dot");
        const label = $("ai-status-text");
        const isOnline = status === "online";
        if (dot) dot.classList.toggle("online", isOnline);
        if (label) label.textContent = isOnline ? "En línea • IA de anime" : (text || "Sin API Key");
        const avatar = $("ai-avatar-glow");
        if (avatar) avatar.classList.toggle("ai-avatar--online", isOnline);
    },

    // ---- Catalog ----
    addToCatalog(items) {
        if (!Array.isArray(items)) return;
        const existing = new Set(AppState.catalogIndex);
        for (const item of items) {
            if (item?.title && !existing.has(item.title)) {
                AppState.catalogIndex.push(item.title);
                existing.add(item.title);
            }
        }
        if (AppState.catalogIndex.length > 1000) {
            AppState.catalogIndex = AppState.catalogIndex.slice(-1000);
        }
    },

    // ---- User Profile Builder ----
    buildUserProfile() {
        const username = localStorage.getItem("profile_username") || "";
        const bio      = localStorage.getItem("profile_bio")      || "";
        let favoriteGenres = [];
        try { favoriteGenres = JSON.parse(localStorage.getItem("profile_genres") || "[]"); } catch(_) {}

        if (!AppState.aiPersonalization) {
            return {
                username, bio, favoriteGenres,
                topGenres: [],
                recentHistory: [],
                watchCount: 0,
                libraryCount: 0,
                watchedIds: [],
            };
        }

        const prefs = AppState.userPreferences || {};
        const topGenres = Object.entries(prefs)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([genre, score]) => `${genre}(${Math.round(score * 10) / 10})`);

        const recentHistory = AppState.history.slice(0, 20).map((h) => h.title);
        const watchedIds = new Set(AppState.history.map((h) => h.id));

        return {
            username, bio, favoriteGenres,
            topGenres,
            recentHistory,
            watchCount: AppState.history.length,
            libraryCount: AppState.library.length,
            watchedIds: [...watchedIds].slice(0, 100),
        };
    },

    // ---- Conversation Persistence ----
    saveConversation() {
        try {
            localStorage.setItem(this.CONV_KEY, JSON.stringify({
                messages: AppState.aiMessages.slice(-80),
                timestamp: Date.now(),
            }));
        } catch {}
    },

    loadConversation() {
        try {
            const saved = JSON.parse(localStorage.getItem(this.CONV_KEY) || "null");
            if (!saved || !Array.isArray(saved.messages)) return;
            if (Date.now() - saved.timestamp > 86400000) return;
            AppState.aiMessages = saved.messages;
            this._renderSavedConversation(saved.messages);
        } catch {}
    },

    _renderSavedConversation(messages) {
        if (!messages.length) return;
        const container = $("ai-chat-container");
        if (!container) return;
        container.innerHTML = "";
        messages.forEach((m) => {
            if (m.role === "user" || m.role === "ai") {
                this.addMessage(m.role, m.text, true);
            } else if (m.role === "recommendations" && Array.isArray(m.data)) {
                this._renderRecommendationCards(m.data, true);
            }
        });
    },

    clearConversation() {
        AppState.aiMessages = [];
        localStorage.removeItem(this.CONV_KEY);
        const container = $("ai-chat-container");
        if (!container) return;
        container.innerHTML = this._welcomeHTML();
        this._rebindQuickChips();
    },

    // ---- Dynamic Quick Chip Generator (pure JS, no AI) ----
    _generateQuickChips() {
        const prefs    = AppState.userPreferences || {};
        const history  = AppState.history || [];
        const library  = AppState.library || [];

        // Seeded random keyed to current day → chips rotate daily, stable within session
        const daySeed  = Math.floor(Date.now() / 86400000);
        const rng      = (salt) => { const x = Math.sin(daySeed * 9301 + salt * 49297 + 1) * 10000; return x - Math.floor(x); };

        // Genres sorted by user score
        const sortedGenres = Object.entries(prefs)
            .filter(([, v]) => v > 0.05)
            .sort((a, b) => b[1] - a[1])
            .map(([k]) => k.toLowerCase().trim());

        // Recent unique titles for "More like X" chips
        const recentTitles = [...new Map(
            [...history, ...library].map(h => [h.id, h.title || h.name])
        ).values()].filter(Boolean).slice(0, 4);

        // ── Chip database keyed by normalized genre ───────────────────────
        const CHIP_DB = {
            "acción": [
                { icon: "🔥", label: "Acción épica",    prompt: "Recomiéndame un anime de acción con combates épicos y excelente animación" },
                { icon: "⚔",  label: "Peleas brutales", prompt: "Quiero un anime con peleas brutales muy bien animadas y protagonista que crece en combate" },
                { icon: "💥", label: "Shounen épico",   prompt: "Recomiéndame el mejor shounen con batallas que te dejen sin aliento" },
            ],
            "isekai": [
                { icon: "✦",  label: "Isekai épico",    prompt: "Recomiéndame un isekai donde el protagonista sea poderoso o muy inteligente" },
                { icon: "⚡", label: "Protagonista OP", prompt: "Busco un isekai donde el protagonista sea ridículamente overpowered" },
                { icon: "🌑", label: "Isekai oscuro",   prompt: "Quiero un isekai con tono oscuro y un protagonista que no es el héroe típico" },
            ],
            "romance": [
                { icon: "🌸", label: "Romance intenso",  prompt: "Busco un anime de romance apasionado que me llene de emociones" },
                { icon: "💕", label: "Romance escolar",  prompt: "Recomiéndame un romance de preparatoria o universidad que sea dulce y emocionante" },
                { icon: "❤",  label: "Historia de amor", prompt: "Quiero un anime donde la historia de amor sea el corazón de toda la trama" },
            ],
            "terror": [
                { icon: "🔪", label: "Terror psicológico", prompt: "Quiero un anime de terror psicológico que me ponga los nervios de punta" },
                { icon: "💀", label: "Horror oscuro",      prompt: "Busco un anime de horror genuinamente perturbador con atmósfera muy densa" },
            ],
            "thriller": [
                { icon: "🕵", label: "Thriller & misterio", prompt: "Recomiéndame un anime de thriller o misterio que me tenga en tensión todo el tiempo" },
                { icon: "🧠", label: "Mente & trampa",      prompt: "Quiero un anime de suspense y juegos mentales, como Death Note o Monster" },
            ],
            "drama": [
                { icon: "🎭", label: "Drama oscuro",  prompt: "Recomiéndame un anime de drama psicológico oscuro que me haga sentir mucho" },
                { icon: "😢", label: "Drama emotivo", prompt: "Busco un anime dramático que sea profundamente emotivo y me mueva por dentro" },
            ],
            "comedia": [
                { icon: "😂", label: "Comedia top",       prompt: "Recomiéndame un anime de comedia que sea genuinamente gracioso" },
                { icon: "🎉", label: "Comedia romántica", prompt: "Quiero una comedia romántica con humor y momentos dulces" },
            ],
            "slice of life": [
                { icon: "☕", label: "Slice of Life",  prompt: "Recomiéndame algo relajante de slice of life, para desconectarme del estrés" },
                { icon: "🌅", label: "Vida cotidiana", prompt: "Busco un anime de vida diaria tranquila que se sienta cálido y acogedor" },
            ],
            "aventuras": [
                { icon: "🗺", label: "Gran aventura", prompt: "Recomiéndame un anime de aventuras épicas con un mundo enorme por descubrir" },
                { icon: "🌍", label: "Mundo inmenso", prompt: "Quiero un anime con worldbuilding increíble y una historia de exploración" },
            ],
            "ciencia ficción": [
                { icon: "🚀", label: "Sci-Fi épico",      prompt: "Recomiéndame un anime de ciencia ficción con buena historia y tecnología avanzada" },
                { icon: "🤖", label: "Mecha & robótica",  prompt: "Quiero un anime de mecha o ciencia ficción con robots gigantes o tecnología futurista" },
            ],
            "deportes": [
                { icon: "🏆", label: "Anime deportivo",   prompt: "Recomiéndame un anime deportivo emocionante que me motive y me ponga de pie" },
                { icon: "⚽", label: "Competición real",  prompt: "Busco un anime de competición deportiva con personajes con los que me identifique" },
            ],
            "sobrenatural": [
                { icon: "👁", label: "Poderes ocultos",   prompt: "Quiero un anime donde los personajes tienen poderes sobrenaturales secretos o únicos" },
                { icon: "🌀", label: "Misterio sobrenatural", prompt: "Busco un anime con elementos sobrenaturales misteriosos y una trama oscura" },
            ],
            "shounen": [
                { icon: "⚡", label: "Shounen top",       prompt: "Recomiéndame el mejor shounen para alguien que quiere emocionarse y sentirse motivado" },
            ],
            "seinen": [
                { icon: "🖤", label: "Seinen maduro",     prompt: "Busco un anime seinen con historia profunda para una audiencia adulta" },
            ],
            "fantasía": [
                { icon: "🔮", label: "Fantasía épica",    prompt: "Recomiéndame un anime de fantasía con un mundo mágico y bien construido" },
                { icon: "🧙", label: "Sistema de magia",  prompt: "Quiero un anime de fantasía donde el sistema de magia esté muy bien definido y sea único" },
            ],
            "misterio": [
                { icon: "🔍", label: "Misterio puro",     prompt: "Busco un anime de misterio donde cada episodio tenga pistas que resolver" },
            ],
            "psicológico": [
                { icon: "🌀", label: "Psicológico",       prompt: "Recomiéndame un anime psicológico que te haga cuestionar la realidad o la moralidad" },
            ],
        };

        // ── Chips siempre disponibles (no dependen del perfil) ───────────
        const UNIVERSAL = [
            { icon: "💫", label: "Tendencias actuales", prompt: "¿Cuáles son los animes más populares y comentados ahora mismo?" },
            { icon: "💎", label: "Joyas ocultas",        prompt: "Recomiéndame animes poco conocidos que sean joyas ocultas que casi nadie ha visto" },
            { icon: "📅", label: "Temporada actual",     prompt: "¿Qué animes están emitiendo esta temporada que valgan la pena?" },
            { icon: "🎯", label: "¿Por dónde empezar?",  prompt: "Soy nuevo en el anime, ¿cuáles son los 5 títulos esenciales que toda persona debe ver?" },
            { icon: "🏅", label: "Los mejores de todos", prompt: "¿Cuáles son los animes mejor valorados de la historia según la comunidad?" },
        ];

        const allGenreKeys = Object.keys(CHIP_DB);
        const picked   = [];
        const usedSet  = new Set();

        const addChip = (chip) => {
            if (!chip || usedSet.has(chip.label)) return false;
            usedSet.add(chip.label);
            picked.push(chip);
            return true;
        };

        const pickFrom = (pool, salt) => {
            if (!pool || pool.length === 0) return null;
            const start = Math.floor(rng(salt) * pool.length);
            for (let i = 0; i < pool.length; i++) {
                const c = pool[(start + i) % pool.length];
                if (!usedSet.has(c.label)) return c;
            }
            return null;
        };

        // 1. Chips de los top 3 géneros del usuario (máx 1 por género)
        sortedGenres.slice(0, 3).forEach((genre, i) => {
            const key  = allGenreKeys.find(k => genre.includes(k) || k.includes(genre)) || genre;
            const pool = CHIP_DB[key];
            if (pool) addChip(pickFrom(pool, i * 17));
        });

        // 2. "Más como [título]" — hasta 2 chips basados en historial reciente
        recentTitles.slice(0, 2).forEach((title, i) => {
            const short = title.length > 16 ? title.slice(0, 15) + "…" : title;
            addChip({ icon: "🔁", label: `Como ${short}`, prompt: `Busco algo muy parecido a "${title}" — misma vibra, personajes similares o trama parecida` });
        });

        // 3. Chip de descubrimiento: género que el usuario casi NO ha explorado
        const unexplored = allGenreKeys.filter(k => !sortedGenres.some(g => g.includes(k) || k.includes(g)));
        if (unexplored.length > 0) {
            const discGenre = unexplored[Math.floor(rng(55) * unexplored.length)];
            const discChip  = pickFrom(CHIP_DB[discGenre], 88);
            if (discChip) addChip({ ...discChip, icon: "🔭", label: `Descubrir: ${discGenre}` });
        }

        // 4. Rellenar con chips universales hasta llegar a 8
        for (let i = 0; picked.length < 8 && i < UNIVERSAL.length; i++) {
            addChip(UNIVERSAL[Math.floor(rng(i + 100) * UNIVERSAL.length)]);
        }

        // 5. Último recurso: cualquier chip del pool
        if (picked.length < 8) {
            const flat = Object.values(CHIP_DB).flat();
            for (let i = 0; picked.length < 8 && i < flat.length * 2; i++) {
                addChip(flat[Math.floor(rng(i + 300) * flat.length)]);
            }
        }

        return picked.slice(0, 8);
    },

    // ---- Welcome Screen ----
    _welcomeHTML() {
        const prefs   = AppState.userPreferences || {};
        const watched = AppState.history?.length || 0;
        const topGenre = Object.entries(prefs).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

        const statsHTML = watched > 0 ? `
            <div class="ai-stats-row">
                <div class="ai-stat-chip">
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    ${watched} visto${watched !== 1 ? "s" : ""}
                </div>
                ${topGenre ? `<div class="ai-stat-chip">
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                    ${topGenre}
                </div>` : ""}
            </div>` : "";

        const chips    = this._generateQuickChips();
        const chipsHTML = chips.map(c =>
            `<button class="ai-quick-chip" data-prompt="${c.prompt.replace(/"/g, "&quot;")}">${c.icon} ${c.label}</button>`
        ).join("");

        const savedName = localStorage.getItem("profile_username") || "";
        let savedGenres = [];
        try { savedGenres = JSON.parse(localStorage.getItem("profile_genres") || "[]"); } catch(_) {}
        const greeting  = savedName ? `Hola, ${savedName}` : "Hola, soy AniBot";
        const subtext   = savedName
            ? `Tu guía de anime con IA${savedGenres.length ? ` · fan de ${savedGenres.join(" y ")}` : ""}. Cuéntame qué buscas.`
            : "Tu guía de anime potenciada con IA. Cuéntame qué buscas y encuentro algo perfecto para ti.";

        return `<div class="ai-welcome-screen">
            <div class="ai-orb-wrapper">
                <div class="ai-orb"><div class="ai-orb-inner">
                    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="white" stroke-width="1.6"><path d="M12 2a5 5 0 0 1 5 5v1h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5z"/><circle cx="9" cy="13" r="1.2" fill="white" stroke="none"/><circle cx="15" cy="13" r="1.2" fill="white" stroke="none"/></svg>
                </div></div>
                <div class="ai-orb-ring"></div>
                <div class="ai-orb-ring ai-orb-ring--2"></div>
            </div>
            <h2 class="ai-welcome-title">${greeting}</h2>
            <p class="ai-welcome-sub">${subtext}</p>
            ${statsHTML}
            <p class="ai-chips-label">Empieza con una pregunta</p>
            <div class="ai-quick-chips">
                ${chipsHTML}
            </div>
        </div>`;
    },

    _rebindQuickChips() {
        document.querySelectorAll(".ai-quick-chip").forEach((chip) => {
            chip.onclick = () => {
                const prompt = chip.dataset.prompt || chip.textContent.replace(/^[\s\S]{1,3}\s/, "").trim();
                this.sendMessage(prompt);
            };
        });
    },

    // ---- Text Formatting ----
    _formatText(raw) {
        const esc = String(raw)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const inline = (s) => s
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

        const lines = esc.split("\n");
        const parts = [];
        let listBuf = [];

        const flushList = () => {
            if (listBuf.length) {
                parts.push(`<ul class="msg-list">${listBuf.map(li => `<li>${li}</li>`).join("")}</ul>`);
                listBuf = [];
            }
        };

        for (const line of lines) {
            const bullet = line.match(/^[\*\-•]\s+([\s\S]*)$/);
            if (bullet) {
                listBuf.push(inline(bullet[1]));
            } else {
                flushList();
                const trimmed = line.trim();
                if (trimmed) parts.push(`<p>${inline(trimmed)}</p>`);
            }
        }
        flushList();

        return parts.length ? parts.join("") : `<p>${inline(esc)}</p>`;
    },

    // ---- Message Queue ----
    sendMessage(text) {
        if (!text?.trim()) return;
        if (!AppState.apiKey) { this._noKeyMessage(); return; }
        this._queue.push(text.trim());
        if (!this._processing) this._drainQueue();
    },

    async _drainQueue() {
        if (!this._queue.length) { this._processing = false; return; }
        this._processing = true;
        await this._doSend(this._queue.shift());
        this._drainQueue();
    },

    async _doSend(text) {
        this.addMessage("user", text);
        this.setLoading(true);

        const userProfile = this.buildUserProfile();
        const messages = AppState.aiMessages
            .filter((m) => m.role === "user" || m.role === "ai")
            .slice(-36)
            .map((m) => ({ role: m.role, text: m.text }));

        try {
            const res = await fetch("/api/ai/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages, userProfile, key: AppState.apiKey, catalogOnly: AppState.aiCatalogOnly }),
            });

            const data = await res.json();

            if (!data.success) {
                const errMsg = data.error || "Error desconocido del servidor.";
                this.addMessage("ai", `⚠️ ${errMsg}`);
                if (res.status === 401) this.updateStatus("offline", "Key inválida");
                return;
            }

            if (data.mood) {
                this._currentMood = data.mood;
                const avatar = $("ai-avatar-glow");
                if (avatar) avatar.dataset.mood = data.mood;
            }

            if (data.text) this.addMessage("ai", data.text);

            if (Array.isArray(data.recommendations) && data.recommendations.length > 0) {
                this._renderRecommendationCards(data.recommendations);
                AppState.aiMessages.push({ role: "recommendations", data: data.recommendations });
            }

            this.saveConversation();
        } catch (err) {
            console.error("[AIManager._doSend]", err);
            this.addMessage("ai", "⚠️ Sin conexión con el servidor. Verifica tu red e intenta de nuevo.");
        } finally {
            this.setLoading(false);
        }
    },

    // ---- Recommendation Cards ----
    _renderRecommendationCards(recs, silent = false) {
        const container = $("ai-chat-container");
        if (!container || !recs.length) return;

        const now = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

        // Outer wrapper for grid + scroll arrow
        const outer = document.createElement("div");
        outer.className = "ai-rec-grid-outer";
        outer.style.animationDelay = "0s";

        const wrap = document.createElement("div");
        wrap.className = "ai-rec-grid";

        recs.forEach((rec, idx) => {
            const isAvailable = rec.available !== false;
            const firstTag = Array.isArray(rec.tags) && rec.tags.length ? rec.tags[0] : null;
            const uid = `rp-${Date.now()}-${idx}`;

            const card = document.createElement("div");
            card.className = "ai-rec-card" + (!isAvailable ? " ai-rec-card--unavailable" : "");
            card.style.animationDelay = `${idx * 0.06}s`;
            card.innerHTML = `
                <div class="ai-rec-poster" id="${uid}">
                    <span class="ai-rec-num">${idx + 1}</span>
                    <button class="ai-rec-heart" aria-label="Guardar">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                        </svg>
                    </button>
                    ${!isAvailable ? '<span class="ai-rec-ext-badge">Externo</span>' : ""}
                </div>
                <div class="ai-rec-body">
                    <div class="ai-rec-title">${this._esc(rec.title)}</div>
                    <div class="ai-rec-bottom">
                        <span class="ai-rec-rating" id="${uid}-r"></span>
                        ${firstTag ? `<span class="ai-rec-tag-pill">${this._esc(firstTag)}</span>` : ""}
                        <button class="ai-rec-more-btn" aria-label="Abrir">⋮</button>
                    </div>
                </div>`;

            // Heart toggle
            card.querySelector(".ai-rec-heart").addEventListener("click", (e) => {
                e.stopPropagation();
                const h = e.currentTarget;
                h.classList.toggle("saved");
            });

            // Three-dots → open detail
            card.querySelector(".ai-rec-more-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                if (isAvailable) this._autoOpenCard(rec.title, card);
                else window.open(`https://www.google.com/search?q=${encodeURIComponent(rec.title + " anime")}`, "_blank", "noopener");
            });

            // Full card tap
            card.addEventListener("click", (e) => {
                if (e.target.closest(".ai-rec-heart") || e.target.closest(".ai-rec-more-btn")) return;
                if (card.classList.contains("ai-rec-card--busy")) return;
                if (isAvailable) this._autoOpenCard(rec.title, card);
                else window.open(`https://www.google.com/search?q=${encodeURIComponent(rec.title + " anime")}`, "_blank", "noopener");
            });

            // Async poster + score load
            if (isAvailable) {
                API.search(rec.title).then((res) => {
                    if (res.success && res.data?.length) {
                        const match = res.data.find(a =>
                            a.title?.toLowerCase().includes(rec.title.toLowerCase()) ||
                            rec.title.toLowerCase().includes(a.title?.toLowerCase())
                        ) || res.data[0];
                        const poster = document.getElementById(uid);
                        if (match?.cover && poster) {
                            poster.style.backgroundImage = `url(${match.cover})`;
                        }
                        const ratingEl = document.getElementById(`${uid}-r`);
                        if (ratingEl && match?.score) {
                            ratingEl.innerHTML = `<svg viewBox="0 0 12 12" width="9" height="9" fill="#fbbf24"><polygon points="6,1 7.8,4.2 11.5,4.6 8.8,7.2 9.5,11 6,9.1 2.5,11 3.2,7.2 0.5,4.6 4.2,4.2"/></svg>${parseFloat(match.score).toFixed(1)}`;
                        }
                    }
                }).catch(() => {});
            }

            wrap.appendChild(card);
        });

        outer.appendChild(wrap);

        // Scroll arrow if 4+ cards
        if (recs.length >= 4) {
            const arrow = document.createElement("button");
            arrow.className = "ai-rec-scroll-arrow";
            arrow.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
            arrow.addEventListener("click", () => wrap.scrollBy({ left: 220, behavior: "smooth" }));
            outer.appendChild(arrow);
        }

        container.appendChild(outer);

        // Follow-up question message (below grid, not silent)
        if (!silent) {
            const fup = document.createElement("div");
            fup.className = "ai-rec-followup-msg";
            fup.innerHTML = `
                <div class="ai-rec-followup-avatar">✨</div>
                <div class="ai-rec-followup-bubble">
                    <div class="ai-rec-followup-title">¿Quieres algo más específico?</div>
                    <div class="ai-rec-followup-sub">Puedo ajustar la recomendación según tus gustos.</div>
                    <div class="msg-meta"><span class="msg-time">${now}</span></div>
                </div>`;
            container.appendChild(fup);
        }

        this._scrollBottom();
    },


    // ---- Card-level open with spring animation ----
    async _autoOpenCard(title, card) {
        if (card.classList.contains("ai-rec-card--busy")) return;
        card.classList.add("ai-rec-card--busy");

        try {
            const res = await API.search(title);
            if (res.success && res.data?.length) {
                const term = title.toLowerCase();
                const match = res.data.find(
                    (a) => a.title.toLowerCase().includes(term) || term.includes(a.title.toLowerCase())
                ) || res.data[0];
                await new Promise((r) => setTimeout(r, 160));
                card.classList.add("ai-rec-card--launch");
                await new Promise((r) => setTimeout(r, 120));
                DetailOverlay.open(match.id);
            } else {
                showToast(`"${title}" no está en el catálogo.`);
            }
        } catch {
            showToast("Error al buscar el título.");
        } finally {
            setTimeout(() => {
                card.classList.remove("ai-rec-card--busy", "ai-rec-card--launch");
            }, 500);
        }
    },

    async _autoOpen(title, btn) {
        // Show spinner on button immediately
        if (btn) btn.classList.add("loading");

        try {
            const res = await API.search(title);
            if (res.success && res.data?.length) {
                const term = title.toLowerCase();
                const match = res.data.find(
                    (a) => a.title.toLowerCase().includes(term) || term.includes(a.title.toLowerCase())
                ) || res.data[0];
                // Small pause so the spinner is visible, then open with premium transition
                await new Promise((r) => setTimeout(r, 180));
                DetailOverlay.open(match.id);
                // Reset button after overlay is visible
                setTimeout(() => { if (btn) btn.classList.remove("loading"); }, 420);
            } else {
                showToast(`"${title}" no está en el catálogo.`);
                if (btn) btn.classList.remove("loading");
            }
        } catch {
            showToast("Error al buscar el título.");
            if (btn) btn.classList.remove("loading");
        }
    },

    _esc(str) {
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },

    _noKeyMessage() {
        if (!AppState.aiMessages.length) {
            const c = $("ai-chat-container");
            if (c) c.innerHTML = "";
        }
        this.addMessage("ai", "🔑 Para usar AniBot necesitas una API key de Gemini. Ve a ⚙️ Configuración, pega tu key y toca Guardar. Consigue una gratis en aistudio.google.com/apikey");
    },

    _scrollBottom() {
        const scroll = $("ai-chat-scroll");
        if (scroll) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    },

    // ---- Message Renderer ----
    addMessage(role, text, silent = false) {
        const container = $("ai-chat-container");
        if (!container) return;

        if (!silent && AppState.aiMessages.length === 0) container.innerHTML = "";

        const isUser = role === "user";
        const now = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
        const bodyHTML = isUser ? `<span class="msg-bubble-text">${this._esc(text)}</span>` : `<div class="msg-bubble-text">${this._formatText(text)}</div>`;
        const checksHTML = isUser
            ? `<span class="msg-checks"><svg viewBox="0 0 18 12" width="14" height="9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 6 5 10 11 2"/><polyline points="7 6 11 10 17 2"/></svg></span>`
            : "";

        const userPhoto = isUser && localStorage.getItem("profile_photo");
        const userAvatarContent = userPhoto
            ? `<div class="msg-avatar-photo" style="background-image:url(${userPhoto})"></div>`
            : this._svgUser;

        const row = document.createElement("div");
        row.className = `msg-row ${isUser ? "user" : "ai"}`;
        row.innerHTML = `
            <div class="msg-row-avatar${userPhoto ? " msg-avatar--photo" : ""}">${isUser ? userAvatarContent : this._svgBot}</div>
            <div class="msg-row-body">
                <div class="msg-bubble">
                    ${bodyHTML}
                    <div class="msg-meta"><span class="msg-time">${now}</span>${checksHTML}</div>
                </div>
            </div>`;

        container.appendChild(row);
        if (!silent) AppState.aiMessages.push({ role, text });
        this._scrollBottom();
    },

    // ---- Typing Indicator ----
    setLoading(on) {
        const btn = $("ai-send");
        const input = $("ai-input");
        if (btn) btn.disabled = on;
        if (input) input.disabled = on;

        const topbar = document.querySelector(".ai-topbar");
        if (topbar) topbar.classList.toggle("ai-topbar--thinking", on);

        if (on) {
            const container = $("ai-chat-container");
            if (!container) return;
            const row = document.createElement("div");
            row.id = "ai-typing-indicator";
            row.className = "typing-indicator";
            row.innerHTML = `
                <div class="msg-row-avatar" style="background:linear-gradient(145deg,#6366f1,#8b5cf6,#a855f7);width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 3px 12px rgba(99,102,241,0.4);">
                    ${this._svgBot}
                </div>
                <div class="typing-bubble">
                    <span class="typing-label">AniBot está escribiendo...</span>
                    <div class="typing-dots">
                        <span class="typing-dot"></span>
                        <span class="typing-dot"></span>
                        <span class="typing-dot"></span>
                    </div>
                </div>`;
            container.appendChild(row);
            this._scrollBottom();
        } else {
            const el = $("ai-typing-indicator");
            if (el) el.remove();
        }
    },

    // ---- Setup ----
    setup() {
        const sendBtn  = $("ai-send");
        const input    = $("ai-input");
        const clearBtn = $("ai-clear-btn");
        const moreBtn  = $("ai-more-btn");
        const moreMenu = $("ai-more-menu");

        if (sendBtn && input) {
            const submit = () => {
                const text = input.value.trim();
                if (text) {
                    this.sendMessage(text);
                    input.value = "";
                    input.style.height = "auto";
                }
            };
            sendBtn.onclick = submit;
            input.onkeydown = (e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            };
            input.oninput = () => {
                input.style.height = "auto";
                input.style.height = Math.min(input.scrollHeight, 100) + "px";
            };
        }

        // More menu toggle
        if (moreBtn && moreMenu) {
            moreBtn.onclick = (e) => {
                e.stopPropagation();
                moreMenu.classList.toggle("hidden");
            };
            document.addEventListener("click", () => {
                if (moreMenu && !moreMenu.classList.contains("hidden")) {
                    moreMenu.classList.add("hidden");
                }
            });
        }

        if (clearBtn) {
            clearBtn.onclick = () => {
                if (moreMenu) moreMenu.classList.add("hidden");
                if (AppState.aiMessages.length === 0) return;
                this.clearConversation();
                showToast("Chat limpiado");
            };
        }

        // Gallery and mic (visual only for now)
        const galleryBtn = $("ai-gallery-btn");
        if (galleryBtn) galleryBtn.onclick = () => showToast("Galería no disponible aún");
        const micBtn = $("ai-mic-btn");
        if (micBtn) micBtn.onclick = () => showToast("Voz no disponible aún");

        const backBtn = $("ai-back-btn");
        if (backBtn) {
            backBtn.onclick = () => {
                Navigation.switchView("view-home");
            };
        }

        this._rebindQuickChips();
    },
};

// ==================== LIBRARY ====================
const Library = {
    _filter: "all",
    _search: "",
    _ctxTargetId: null,
    _searchTimer: null,

    _migrateItem(item) {
        if (!item.status) {
            item.status = AppState.history.some(h => h.id === item.id) ? "progress" : "pending";
        }
        if (item.favorite === undefined) item.favorite = false;
        if (!item.addedAt) item.addedAt = Date.now();
        return item;
    },

    getEffectiveStatus(item) {
        if (item.status === "completed") return "completed";
        if (item.status === "pending") return "pending";
        const inHistory = AppState.history.some(h => h.id === item.id);
        if (inHistory || item.status === "progress") return "progress";
        return "pending";
    },

    getFiltered() {
        const q = this._search.toLowerCase().trim();
        return AppState.library.filter(item => {
            this._migrateItem(item);
            const status = this.getEffectiveStatus(item);
            const matchesFilter =
                this._filter === "all" ||
                (this._filter === "favorites" && item.favorite) ||
                status === this._filter;
            const matchesSearch = !q || item.title.toLowerCase().includes(q);
            return matchesFilter && matchesSearch;
        });
    },

    updateSubtitle() {
        const el = $("lib-subtitle");
        if (!el) return;
        const total = AppState.library.length;
        const inProgress = AppState.library.filter(i => this.getEffectiveStatus(i) === "progress").length;
        const base = `${total} anime${total !== 1 ? "s" : ""} guardado${total !== 1 ? "s" : ""}`;
        el.innerHTML = inProgress > 0
            ? `${base} · <span style="color:var(--accent-primary);font-weight:600">${inProgress} en progreso</span>`
            : base;
    },

    updateBadges() {
        const all = AppState.library.length;
        const progress = AppState.library.filter(i => this.getEffectiveStatus(i) === "progress").length;
        const completed = AppState.library.filter(i => this.getEffectiveStatus(i) === "completed").length;
        const pending = AppState.library.filter(i => this.getEffectiveStatus(i) === "pending").length;
        const favorites = AppState.library.filter(i => i.favorite).length;
        const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
        set("lib-badge-all", all);
        set("lib-badge-progress", progress);
        set("lib-badge-completed", completed);
        set("lib-badge-pending", pending);
        set("lib-badge-favorites", favorites);
    },

    _animateCardOut(id, callback) {
        const card = document.querySelector(`.lib-card[data-id="${id}"]`);
        if (!card) { callback && callback(); return; }
        card.style.transition = "opacity 0.22s ease, transform 0.22s ease";
        card.style.opacity = "0";
        card.style.transform = "scale(0.88)";
        setTimeout(() => { card.remove(); callback && callback(); }, 240);
    },

    _patchCard(id) {
        const item = AppState.library.find(a => a.id === id);
        if (!item) { this.render(); return; }
        const card = document.querySelector(`.lib-card[data-id="${id}"]`);
        if (!card) return;
        const status = this.getEffectiveStatus(item);
        const statusLabels = { progress: "En progreso", completed: "Completado", pending: "Pendiente" };
        const favBtn = card.querySelector(".lib-card-fav");
        if (favBtn) {
            favBtn.classList.toggle("active", item.favorite);
            const svg = favBtn.querySelector("svg");
            if (svg) svg.setAttribute("fill", item.favorite ? "currentColor" : "none");
            favBtn.classList.remove("pulse");
            requestAnimationFrame(() => {
                favBtn.classList.add("pulse");
                favBtn.addEventListener("animationend", () => favBtn.classList.remove("pulse"), { once: true });
            });
        }
        const badge = card.querySelector(".lib-card-status-badge");
        if (badge) {
            badge.className = `lib-card-status-badge status-${status}`;
            badge.textContent = statusLabels[status];
        }
    },

    buildCard(item, idx) {
        const historyItem = AppState.history.find(h => h.id === item.id);
        const status = this.getEffectiveStatus(item);
        const statusLabels = { progress: "En progreso", completed: "Completado", pending: "Pendiente" };

        let epText = "";
        let progressPct = 0;
        if (historyItem) {
            epText = `Ep. ${historyItem.lastEp || 1}`;
            if (historyItem.progressMap && historyItem.lastEp) {
                progressPct = historyItem.progressMap[historyItem.lastEp] || 0;
            }
        }

        const cover = item.cover && item.cover.length > 0
            ? item.cover
            : "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

        const card = document.createElement("div");
        card.className = "lib-card";
        card.style.animationDelay = `${Math.min(idx, 12) * 0.04}s`;
        card.dataset.id = item.id;

        card.innerHTML = `
            <div class="lib-card-img-wrap">
                <img class="lib-card-img" src="${cover}" alt="${item.title}" loading="lazy">
                <div class="lib-card-overlay"></div>
                <button class="lib-card-fav${item.favorite ? " active" : ""}" data-id="${item.id}" aria-label="Favorito">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="${item.favorite ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                </button>
                <button class="lib-card-more" data-id="${item.id}" aria-label="Más opciones">⋮</button>
                <div class="lib-card-info">
                    <p class="lib-card-title">${item.title}</p>
                    <span class="lib-card-status-badge status-${status}">${statusLabels[status]}</span>
                    ${epText ? `<span class="lib-card-ep">${epText}</span>` : ""}
                    ${progressPct > 0 ? `<div class="lib-card-progress-bar"><div class="lib-card-progress-fill" style="width:${Math.min(progressPct,100)}%"></div></div>` : ""}
                </div>
            </div>
        `;

        const img = card.querySelector(".lib-card-img");
        img.addEventListener("load", () => {
            img.classList.add("loaded");
            const wrap = img.closest(".lib-card-img-wrap");
            if (wrap) wrap.classList.add("img-loaded");
        });
        img.addEventListener("error", () => {
            img.src = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
            img.classList.add("loaded");
            const wrap = img.closest(".lib-card-img-wrap");
            if (wrap) wrap.classList.add("img-loaded");
        });

        card.addEventListener("click", (e) => {
            if (e.target.closest(".lib-card-fav") || e.target.closest(".lib-card-more")) return;
            DetailOverlay.open(item.id);
        });

        card.querySelector(".lib-card-fav").addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggleFavorite(item.id);
        });

        card.querySelector(".lib-card-more").addEventListener("click", (e) => {
            e.stopPropagation();
            this.openContextMenu(item.id);
        });

        let longPressTimer;
        card.addEventListener("touchstart", () => {
            longPressTimer = setTimeout(() => this.openContextMenu(item.id), 500);
        }, { passive: true });
        card.addEventListener("touchend", () => clearTimeout(longPressTimer));
        card.addEventListener("touchmove", () => clearTimeout(longPressTimer), { passive: true });

        return card;
    },

    render() {
        const grid = $("library-grid");
        const empty = $("library-empty");
        if (!grid) return;

        AppState.library.forEach(item => this._migrateItem(item));
        this.updateSubtitle();
        this.updateBadges();

        const items = this.getFiltered();
        grid.innerHTML = "";

        if (items.length === 0) {
            if (empty) {
                empty.classList.remove("hidden");
                const sub = $("lib-empty-sub");
                if (sub) {
                    if (this._search) {
                        sub.textContent = `No hay resultados para "${this._search}"`;
                    } else if (this._filter !== "all") {
                        const labels = { progress: "en progreso", completed: "completados", pending: "pendientes", favorites: "en favoritos" };
                        sub.textContent = `No tienes animes ${labels[this._filter] || "aquí"}`;
                    } else {
                        sub.textContent = "Aún no tienes animes guardados";
                    }
                }
            }
        } else {
            if (empty) empty.classList.add("hidden");
            items.forEach((item, idx) => {
                grid.appendChild(this.buildCard(item, idx));
            });
        }
    },

    toggle(anime) {
        const idx = AppState.library.findIndex((a) => a.id === anime.id);
        if (idx > -1) {
            AppState.library.splice(idx, 1);
            showToast("Eliminado de la biblioteca");
            Recommendations.registerFavorite(anime, false);
        } else {
            AppState.library.push({
                id: anime.id,
                title: anime.title,
                cover: anime.cover,
                status: AppState.history.some(h => h.id === anime.id) ? "progress" : "pending",
                favorite: false,
                addedAt: Date.now(),
            });
            showToast("Guardado en la biblioteca");
            Recommendations.registerFavorite(anime, true);
        }
        localStorage.setItem("anime_library", JSON.stringify(AppState.library));
        DetailOverlay.updateLibraryBtn();
        this.render();
    },

    toggleFavorite(id) {
        const item = AppState.library.find(a => a.id === id);
        if (!item) return;
        item.favorite = !item.favorite;
        localStorage.setItem("anime_library", JSON.stringify(AppState.library));
        showToast(item.favorite ? "Añadido a favoritos" : "Quitado de favoritos");
        if (this._filter === "favorites" && !item.favorite) {
            this._animateCardOut(id, () => {
                this.updateBadges();
                this.updateSubtitle();
                const grid = $("library-grid");
                const empty = $("library-empty");
                if (grid && grid.children.length === 0 && empty) empty.classList.remove("hidden");
            });
        } else {
            this._patchCard(id);
            this.updateBadges();
            this.updateSubtitle();
        }
    },

    updateStatus(id, status) {
        const item = AppState.library.find(a => a.id === id);
        if (!item) return;
        item.status = status;
        localStorage.setItem("anime_library", JSON.stringify(AppState.library));
        const labels = { progress: "En progreso", completed: "Completado", pending: "Pendiente" };
        showToast(`Marcado como: ${labels[status] || status}`);
        const effectiveStatus = this.getEffectiveStatus(item);
        const filterMismatch = this._filter !== "all" && this._filter !== effectiveStatus && this._filter !== "favorites";
        if (filterMismatch) {
            this._animateCardOut(id, () => {
                this.updateBadges();
                this.updateSubtitle();
                const grid = $("library-grid");
                const empty = $("library-empty");
                if (grid && grid.children.length === 0 && empty) empty.classList.remove("hidden");
            });
        } else {
            this._patchCard(id);
            this.updateBadges();
            this.updateSubtitle();
        }
    },

    remove(id) {
        const item = AppState.library.find(a => a.id === id);
        if (!item) return;
        const itemCopy = { ...item };
        this._animateCardOut(id, () => {
            const idx = AppState.library.findIndex(a => a.id === id);
            if (idx > -1) AppState.library.splice(idx, 1);
            localStorage.setItem("anime_library", JSON.stringify(AppState.library));
            Recommendations.registerFavorite(itemCopy, false);
            showToast("Eliminado de la biblioteca");
            this.updateBadges();
            this.updateSubtitle();
            const grid = $("library-grid");
            const empty = $("library-empty");
            if (grid && grid.children.length === 0 && empty) empty.classList.remove("hidden");
        });
    },

    openContextMenu(id) {
        this._ctxTargetId = id;
        const item = AppState.library.find(a => a.id === id);
        if (!item) return;
        const favLabel = $("lib-ctx-fav-label");
        if (favLabel) favLabel.textContent = item.favorite ? "Quitar de favoritos" : "Añadir a favoritos";
        const menu = $("lib-ctx-menu");
        const backdrop = $("lib-ctx-backdrop");
        if (menu) { menu.classList.remove("hidden"); requestAnimationFrame(() => menu.classList.add("visible")); }
        if (backdrop) { backdrop.classList.remove("hidden"); requestAnimationFrame(() => backdrop.classList.add("visible")); }
    },

    closeContextMenu() {
        const menu = $("lib-ctx-menu");
        const backdrop = $("lib-ctx-backdrop");
        if (menu) {
            menu.classList.remove("visible");
            setTimeout(() => menu.classList.add("hidden"), 320);
        }
        if (backdrop) {
            backdrop.classList.remove("visible");
            setTimeout(() => backdrop.classList.add("hidden"), 250);
        }
        this._ctxTargetId = null;
    },

    setup() {
        const btn = $("btn-library");
        if (btn) {
            btn.addEventListener("click", () => {
                if (AppState.currentAnime) this.toggle(AppState.currentAnime);
            });
        }

        const searchInput = $("lib-search-input");
        const searchClear = $("lib-search-clear");
        if (searchInput) {
            searchInput.addEventListener("input", (e) => {
                this._search = e.target.value;
                if (searchClear) searchClear.classList.toggle("hidden", !this._search);
                clearTimeout(this._searchTimer);
                this._searchTimer = setTimeout(() => this.render(), 150);
            });
        }
        if (searchClear) {
            searchClear.addEventListener("click", () => {
                if (searchInput) searchInput.value = "";
                this._search = "";
                searchClear.classList.add("hidden");
                this.render();
            });
        }

        document.querySelectorAll(".lib-tab").forEach(tab => {
            tab.addEventListener("click", () => {
                document.querySelectorAll(".lib-tab").forEach(t => t.classList.remove("active"));
                tab.classList.add("active");
                this._filter = tab.dataset.filter;
                this.render();
            });
        });

        const exploreBtn = $("lib-explore-btn");
        if (exploreBtn) {
            exploreBtn.addEventListener("click", () => {
                Navigation.switchView("view-search");
                const navBtn = document.querySelector('.nav-item-premium[data-target="view-search"]');
                if (navBtn) navBtn.click();
            });
        }

        const ctxFav = $("lib-ctx-fav");
        const ctxCompleted = $("lib-ctx-completed");
        const ctxPending = $("lib-ctx-pending");
        const ctxRemove = $("lib-ctx-remove");
        const ctxBackdrop = $("lib-ctx-backdrop");

        if (ctxFav) ctxFav.addEventListener("click", () => { const id = this._ctxTargetId; this.closeContextMenu(); if (id) this.toggleFavorite(id); });
        if (ctxCompleted) ctxCompleted.addEventListener("click", () => { const id = this._ctxTargetId; this.closeContextMenu(); if (id) this.updateStatus(id, "completed"); });
        if (ctxPending) ctxPending.addEventListener("click", () => { const id = this._ctxTargetId; this.closeContextMenu(); if (id) this.updateStatus(id, "pending"); });
        if (ctxRemove) ctxRemove.addEventListener("click", () => { const id = this._ctxTargetId; this.closeContextMenu(); if (id) this.remove(id); });
        if (ctxBackdrop) ctxBackdrop.addEventListener("click", () => this.closeContextMenu());

        // Swipe down to close context menu
        const ctxMenuEl = $("lib-ctx-menu");
        if (ctxMenuEl) {
            let swipeStartY = 0;
            ctxMenuEl.addEventListener("touchstart", (e) => {
                swipeStartY = e.touches[0].clientY;
                ctxMenuEl.style.transition = "none";
            }, { passive: true });
            ctxMenuEl.addEventListener("touchmove", (e) => {
                const dy = e.touches[0].clientY - swipeStartY;
                if (dy > 0) ctxMenuEl.style.transform = `translateY(${dy}px)`;
            }, { passive: true });
            ctxMenuEl.addEventListener("touchend", (e) => {
                const dy = e.changedTouches[0].clientY - swipeStartY;
                ctxMenuEl.style.transition = "";
                if (dy > 60) {
                    this.closeContextMenu();
                } else {
                    ctxMenuEl.style.transform = ctxMenuEl.classList.contains("visible") ? "translateY(0)" : "translateY(100%)";
                }
            });
        }
    },
};

// ==================== NAVIGATION ====================
const Navigation = {
    currentView: "view-home",
    setup() {
        document.querySelectorAll(".nav-item-premium").forEach((btn) => {
            btn.addEventListener("click", () => {
                const target = btn.dataset.target;

                // Si tocamos el botón de buscar y ya estamos en buscar, reseteamos a categorías
                if (
                    target === "view-search" &&
                    this.currentView === "view-search"
                ) {
                    Search.reset();
                }

                this.switchView(target);
            });
        });

        const btnBackCat = $("btn-back-category");
        if (btnBackCat) {
            btnBackCat.addEventListener("click", () => {
                this.switchView("view-home");
            });
        }

        const btnCloseDetail = $("btn-close-detail");
        if (btnCloseDetail) {
            btnCloseDetail.addEventListener("click", () => {
                DetailOverlay.close();
            });
        }

        const btnClosePlayer = $("btn-close-player");
        if (btnClosePlayer) {
            btnClosePlayer.addEventListener("click", () => {
                PlayerOverlay.close();
            });
        }

        const btnFullscreen = $("btn-fullscreen-player");
        if (btnFullscreen) {
            btnFullscreen.addEventListener("click", () => {
                if (PlayerOverlay.cinemaMode) {
                    PlayerOverlay.exitCinema();
                } else {
                    PlayerOverlay.enterCinema();
                }
            });
        }

        // Sync state if user presses Esc to exit native fullscreen
        const _onFsChange = () => {
            const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
            if (!inFs && PlayerOverlay.cinemaMode) {
                PlayerOverlay.cinemaMode = false;
                const ov = $("overlay-player");
                if (ov) ov.classList.remove("player-cinema");
                const btn = $("btn-fullscreen-player");
                if (btn) btn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>`;
                if (PlayerOverlay.peekTimer) { clearTimeout(PlayerOverlay.peekTimer); PlayerOverlay.peekTimer = null; }
            }
        };
        document.addEventListener("fullscreenchange", _onFsChange);
        document.addEventListener("webkitfullscreenchange", _onFsChange);
    },

    switchView(target) {
        this.currentView = target;
        document.querySelectorAll(".view").forEach((v) => {
            v.classList.remove("active");
        });
        const targetEl = $(target);
        if (targetEl) targetEl.classList.add("active");

        document.querySelectorAll(".nav-item-premium").forEach((n) => {
            n.classList.remove("active");
        });
        const navBtn = document.querySelector(`[data-target="${target}"]`);
        if (navBtn) navBtn.classList.add("active");

        const nav = document.querySelector(".bottom-nav-premium");
        if (nav) nav.classList.toggle("nav-hidden", target === "view-ai" || target === "view-info-table");

        // Re-render library when switching to it so status is always fresh
        if (target === "view-library") {
            Library.render();
        }

        // Settings: re-animate and refresh stats on every visit
        if (target === "view-settings") {
            Settings.animateIn();
            Settings.updateProfileStats();
            Settings.updateKeyStatus();
        }

        // Asegurar que los géneros de búsqueda se carguen al entrar
        if (target === "view-search") {
            const input = $("search-input");
            if (input && input.value.trim().length === 0) {
                const message = $("search-message");
                if (message) {
                    message.style.display = "flex";
                    // Animación de entrada para el buscador vacío
                    message.style.animation = "fadeInUp 0.6s ease-out forwards";
                }
                Search.renderDiscoverGenres();
            }
        }
    },
};

// ==================== SETTINGS ====================
const Settings = {
    _accentMap: {
        "#6366f1": "#8b5cf6",
        "#3b82f6": "#60a5fa",
        "#ec4899": "#f472b6",
        "#22c55e": "#4ade80",
    },

    // ── Ripple helper ──────────────────────────────────────────
    _addRipple(row, e) {
        const rect = row.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 1.8;
        const x = (e.clientX || rect.left + rect.width / 2) - rect.left - size / 2;
        const y = (e.clientY || rect.top + rect.height / 2) - rect.top - size / 2;
        const span = document.createElement("span");
        span.className = "cfg-ripple-span";
        span.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px;`;
        row.appendChild(span);
        span.addEventListener("animationend", () => span.remove());
    },

    // ── Theme (dark / light) ─────────────────────────────────
    applyTheme(theme) {
        const root = document.documentElement;
        root.classList.add("theme-switching");
        if (theme === "light") {
            root.setAttribute("data-theme", "light");
        } else {
            root.removeAttribute("data-theme");
        }
        clearTimeout(this._themeSwitchTimer);
        this._themeSwitchTimer = setTimeout(() => root.classList.remove("theme-switching"), 380);
    },

    // ── Accent color ──────────────────────────────────────────
    applyAccentColor(color) {
        const secondary = this._accentMap[color] || color;
        document.documentElement.style.setProperty("--accent-primary", color);
        document.documentElement.style.setProperty("--accent-secondary", secondary);
        localStorage.setItem("accent_color", color);
        document.querySelectorAll(".cfg-color-dot").forEach(dot => {
            dot.classList.toggle("active", dot.dataset.color === color);
        });
    },

    // ── Card size ────────────────────────────────────────────
    applyCardSize(size) {
        document.body.dataset.cardSize = size;
        localStorage.setItem("card_size", size);
        document.querySelectorAll(".cfg-size-pill").forEach(p => {
            p.classList.toggle("active", p.dataset.size === size);
        });
    },

    // ── API key status indicator ──────────────────────────────
    updateKeyStatus() {
        const badge = $("cfg-key-badge");
        const status = $("cfg-key-status");
        const hasKey = !!(AppState.apiKey && AppState.apiKey.trim());
        if (badge) {
            badge.className = "cfg-key-badge visible " + (hasKey ? "cfg-key-badge--ok" : "cfg-key-badge--no");
            badge.innerHTML = `<span class="cfg-key-badge-dot"></span>${hasKey ? "Guardada" : "Sin clave"}`;
        }
        if (status) {
            status.className = "cfg-key-status visible " + (hasKey ? "cfg-key-status--ok" : "cfg-key-status--no");
            status.innerHTML = `<span class="cfg-key-status-dot"></span>${hasKey ? "Clave activa — recomendaciones IA habilitadas" : "Sin clave — agrega una para activar la IA"}`;
        }
    },

    // ── Profile stats ─────────────────────────────────────────
    updateProfileStats() {
        const libCount = (AppState.library || []).length;
        const watchedAnimes = new Set((AppState.history || []).map(h => h.id)).size;
        const completedCount = (AppState.library || []).filter(e => e.status === "completed").length;
        const libEl = $("cfg-stat-library");
        const watchedEl = $("cfg-stat-watched");
        const completedEl = $("cfg-stat-completed");
        if (libEl) libEl.textContent = libCount;
        if (watchedEl) watchedEl.textContent = watchedAnimes;
        if (completedEl) completedEl.textContent = completedCount;
    },

    // ── Entrance stagger animation ────────────────────────────
    animateIn() {
        const view = $("view-settings");
        if (!view) return;
        const els = view.querySelectorAll(".cfg-anim");
        els.forEach(el => {
            el.style.animation = "none";
            el.style.opacity = "0";
            void el.offsetWidth; // force reflow so next frame truly re-triggers
        });
        requestAnimationFrame(() => {
            els.forEach(el => {
                el.style.animation = "";
                el.style.opacity  = "";
            });
        });
    },

    // ── About sheet ───────────────────────────────────────────
    _openSheet() {
        const backdrop = $("cfg-sheet-backdrop");
        const sheet = $("cfg-about-sheet");
        const nav = document.querySelector(".bottom-nav-premium");
        if (backdrop && sheet) {
            backdrop.classList.add("open");
            sheet.classList.add("open");
            if (nav) nav.classList.add("nav-hidden");
            backdrop.onclick = () => this._closeSheet();
        }
    },

    _closeSheet() {
        const backdrop = $("cfg-sheet-backdrop");
        const sheet = $("cfg-about-sheet");
        const nav = document.querySelector(".bottom-nav-premium");
        if (backdrop && sheet) {
            backdrop.classList.remove("open");
            sheet.classList.remove("open");
            if (nav) nav.classList.remove("nav-hidden");
        }
    },

    // ── Toggle label helper ───────────────────────────────────
    _setToggleLabel(el, on) {
        if (!el) return;
        el.textContent = on ? "Activado" : "Desactivado";
        el.classList.toggle("cfg-toggle-label--on", on);
        el.classList.toggle("cfg-toggle-label--off", !on);
    },

    // ── Main setup ────────────────────────────────────────────
    setup() {
        // Apply saved preferences immediately
        const savedColor = localStorage.getItem("accent_color") || "#6366f1";
        this.applyAccentColor(savedColor);
        this.applyCardSize(localStorage.getItem("card_size") || "normal");

        // ── Ripple on all tappable rows ──
        document.querySelectorAll("#view-settings .cfg-row:not(.cfg-row--notap)").forEach(row => {
            row.addEventListener("pointerdown", e => this._addRipple(row, e));
        });

        // ── Clear cache ──
        const clearBtn = $("btn-clear-cache");
        if (clearBtn) {
            clearBtn.addEventListener("click", () => {
                if (confirm("¿Limpiar todos los datos locales?\nEsto elimina tu biblioteca e historial.")) {
                    localStorage.clear();
                    location.reload();
                }
            });
        }

        // ── API key ──
        const apiKeyInput = $("gemini-api-key");
        const saveKeyBtn = $("btn-save-key");
        if (apiKeyInput) {
            apiKeyInput.value = AppState.apiKey || "";
            this.updateKeyStatus();
        }
        if (apiKeyInput && saveKeyBtn) {
            saveKeyBtn.onclick = () => {
                const key = apiKeyInput.value.trim();
                if (key) {
                    AppState.apiKey = key;
                    localStorage.setItem("gemini_api_key", key);
                    this.updateKeyStatus();
                    showToast("API Key guardada correctamente");
                    AIManager.init();
                } else if (confirm("¿Deseas eliminar la API Key guardada?")) {
                    AppState.apiKey = null;
                    localStorage.removeItem("gemini_api_key");
                    apiKeyInput.value = "";
                    this.updateKeyStatus();
                    AIManager.init();
                }
            };
        }

        // ── Eye toggle ──
        const eyeBtn = $("btn-toggle-key-vis");
        if (eyeBtn && apiKeyInput) {
            eyeBtn.addEventListener("click", () => {
                const show = apiKeyInput.type === "password";
                apiKeyInput.type = show ? "text" : "password";
                eyeBtn.innerHTML = show
                    ? `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
                    : `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
            });
        }

        // ── AI personalization toggle ──
        const aiToggle = $("toggle-ai-personalization");
        const aiLabel = $("personalization-status-label");
        if (aiToggle) {
            aiToggle.checked = AppState.aiPersonalization;
            this._setToggleLabel(aiLabel, aiToggle.checked);
            aiToggle.addEventListener("change", () => {
                AppState.aiPersonalization = aiToggle.checked;
                localStorage.setItem("ai_personalization", aiToggle.checked ? "on" : "off");
                this._setToggleLabel(aiLabel, aiToggle.checked);
                showToast(aiToggle.checked ? "Personalización activada" : "Modo conversacional activado");
            });
        }

        // ── AI catalog toggle ──
        const catToggle = $("toggle-ai-catalog-only");
        const catLabel = $("catalog-only-status-label");
        if (catToggle) {
            catToggle.checked = AppState.aiCatalogOnly;
            this._setToggleLabel(catLabel, catToggle.checked);
            catToggle.addEventListener("change", () => {
                AppState.aiCatalogOnly = catToggle.checked;
                localStorage.setItem("ai_catalog_only", catToggle.checked ? "on" : "off");
                this._setToggleLabel(catLabel, catToggle.checked);
                showToast(catToggle.checked ? "Catálogo: solo títulos disponibles" : "Catálogo: cualquier anime");
            });
        }

        // ── Dark / Light mode toggle ──
        const darkToggle = $("toggle-dark-mode");
        const darkRowSub = $("dark-mode-row-sub");
        if (darkToggle) {
            const saved = localStorage.getItem("theme");
            const isDark = saved !== "light";
            darkToggle.checked = isDark;
            this.applyTheme(isDark ? "dark" : "light");
            if (darkRowSub) darkRowSub.textContent = isDark ? "Tema oscuro activo" : "Tema claro activo";
            darkToggle.addEventListener("change", () => {
                const theme = darkToggle.checked ? "dark" : "light";
                this.applyTheme(theme);
                localStorage.setItem("theme", theme);
                if (darkRowSub) darkRowSub.textContent = darkToggle.checked ? "Tema oscuro activo" : "Tema claro activo";
                showToast(darkToggle.checked ? "Modo oscuro activado" : "Modo claro activado");
            });
        }

        // ── Accent color picker ──
        document.querySelectorAll(".cfg-color-dot").forEach(dot => {
            dot.addEventListener("click", () => {
                this.applyAccentColor(dot.dataset.color);
                showToast("Color de acento actualizado");
            });
        });

        // ── Card size pills ──
        document.querySelectorAll(".cfg-size-pill").forEach(pill => {
            pill.addEventListener("click", () => {
                this.applyCardSize(pill.dataset.size);
                const names = { small: "Pequeño", normal: "Normal", large: "Grande" };
                showToast(`Tarjetas: ${names[pill.dataset.size] || pill.dataset.size}`);
            });
        });

        // ── Edit profile ──
        const editBtn = $("cfg-edit-profile");
        if (editBtn) editBtn.addEventListener("click", () => ProfileEditor.open());

        // ── Info table view ──
        const tableBtn = $("cfg-table-btn");
        if (tableBtn) tableBtn.addEventListener("click", () => window.InfoTableManager?.open());

        // ── About sheet ──
        const aboutBtn = $("cfg-about-btn");
        if (aboutBtn) aboutBtn.addEventListener("click", () => this._openSheet());
        const closeBtn = $("cfg-sheet-close");
        if (closeBtn) closeBtn.addEventListener("click", () => this._closeSheet());

        // ── Privacy ──
        const privacyBtn = $("cfg-privacy-btn");
        if (privacyBtn) privacyBtn.addEventListener("click", () => showToast("Política de privacidad próximamente"));

        // ── Initial stats ──
        this.updateProfileStats();
    },
};

// ==================== PROFILE INTEGRATIONS ====================
function refreshProfileIntegrations() {
    const photo    = localStorage.getItem("profile_photo");
    const username = localStorage.getItem("profile_username") || "";

    // 1. Nav bar settings button → user avatar
    const navWrap = $("nav-avatar-wrap");
    if (navWrap) {
        if (photo) {
            navWrap.style.backgroundImage = `url(${photo})`;
            navWrap.classList.add("has-photo");
        } else {
            navWrap.style.backgroundImage = "";
            navWrap.classList.remove("has-photo");
        }
    }

    // 2. Home "Para ti" subtitle personalization
    const homeSub = document.querySelector(".recommendation-panel .section-subtitle");
    if (homeSub) {
        homeSub.textContent = username
            ? `Para ${username} · ajustado a tus gustos`
            : "Ajustado a tus gustos dinámicos";
    }

    // 3. AI welcome — regenerate if no messages yet
    const chatContainer = $("ai-chat-container");
    if (chatContainer && AppState.aiMessages.length === 0) {
        chatContainer.innerHTML = AIManager._welcomeHTML();
        AIManager._rebindQuickChips();
    }
}

// ==================== PROFILE EDITOR ====================
const ProfileEditor = {
    _GENRES: [
        { id: "accion",   label: "Acción" },
        { id: "comedia",  label: "Comedia" },
        { id: "romance",  label: "Romance" },
        { id: "isekai",   label: "Isekai" },
        { id: "shounen",  label: "Shōnen" },
        { id: "aventura", label: "Aventura" },
        { id: "fantasia", label: "Fantasía" },
        { id: "drama",    label: "Drama" },
        { id: "terror",   label: "Terror" },
        { id: "misterio", label: "Misterio" },
    ],

    open() {
        const overlay = $("profile-edit-overlay");
        if (!overlay) return;
        const nav = document.querySelector(".bottom-nav-premium");
        if (nav) nav.classList.add("nav-hidden");
        this._load();
        overlay.setAttribute("aria-hidden", "false");
        overlay.classList.add("is-open");
        document.body.style.overflow = "hidden";
    },

    close() {
        const overlay = $("profile-edit-overlay");
        if (!overlay) return;
        overlay.classList.remove("is-open");
        overlay.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "";
        setTimeout(() => {
            const nav = document.querySelector(".bottom-nav-premium");
            if (nav) nav.classList.remove("nav-hidden");
        }, 340);
    },

    _load() {
        const username = localStorage.getItem("profile_username") || "";
        const bio      = localStorage.getItem("profile_bio")      || "";
        const photo    = localStorage.getItem("profile_photo");

        let genres = [];
        try { genres = JSON.parse(localStorage.getItem("profile_genres") || "[]"); } catch(_) {}

        const uEl = $("pe-username");
        const bEl = $("pe-bio");
        if (uEl) { uEl.value = username; this._updateCharCount("pe-username-count", username.length, 28); }
        if (bEl) { bEl.value = bio;      this._updateCharCount("pe-bio-count",      bio.length,      60); }

        this._renderAvatarPreview(photo);

        document.querySelectorAll(".pe-genre-chip").forEach(c =>
            c.classList.toggle("active", genres.includes(c.dataset.genre))
        );
        this._updateGenreCount();
    },

    _renderAvatarPreview(dataUrl) {
        const el = $("pe-avatar-preview");
        if (!el) return;
        if (dataUrl) {
            el.style.backgroundImage  = `url(${dataUrl})`;
            el.style.backgroundSize   = "cover";
            el.style.backgroundPosition = "center";
            el.innerHTML = "";
        } else {
            el.style.backgroundImage = "";
            el.innerHTML = `<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
        }
    },

    save() {
        const username = ($("pe-username")?.value || "").trim();
        const bio      = ($("pe-bio")?.value      || "").trim();
        const genres   = [...document.querySelectorAll(".pe-genre-chip.active")]
                            .map(c => c.dataset.genre);

        localStorage.setItem("profile_username", username);
        localStorage.setItem("profile_bio",      bio);
        localStorage.setItem("profile_genres",   JSON.stringify(genres));

        this.applyToCard();
        refreshProfileIntegrations();
        showToast("Perfil actualizado");
        this.close();
    },

    _updateCharCount(id, len, max) {
        const el = $(id);
        if (!el) return;
        el.textContent = `${len}/${max}`;
        el.classList.toggle("near",   len >= Math.floor(max * 0.8) && len < max);
        el.classList.toggle("at-max", len >= max);
    },

    _updateGenreCount() {
        const count   = document.querySelectorAll(".pe-genre-chip.active").length;
        const badge   = $("pe-genre-count");
        if (!badge) return;
        badge.textContent = `${count} / 2`;
        badge.classList.toggle("has-one", count === 1);
        badge.classList.toggle("is-full", count === 2);
    },

    // Called on load and after save to sync the settings card
    applyToCard() {
        if (window.AuthManager?.isAuthenticated()) { window.AuthManager.refreshCard(); return; }
        const username = localStorage.getItem("profile_username") || "";
        const bio      = localStorage.getItem("profile_bio")      || "";
        const photo    = localStorage.getItem("profile_photo");
        let genres = [];
        try { genres = JSON.parse(localStorage.getItem("profile_genres") || "[]"); } catch(_) {}

        const nameEl   = document.querySelector(".cfg-profile-name");
        const subEl    = document.querySelector(".cfg-profile-sub");
        const avatarEl = $("cfg-avatar");
        const genreWrap = $("cfg-profile-genres");

        if (nameEl) nameEl.textContent = username || "Usuario";
        if (subEl)  subEl.textContent  = bio      || "Gestiona tu cuenta";

        if (avatarEl) {
            if (photo) {
                avatarEl.style.backgroundImage   = `url(${photo})`;
                avatarEl.style.backgroundSize    = "cover";
                avatarEl.style.backgroundPosition = "center";
                avatarEl.innerHTML = "";
            } else {
                avatarEl.style.backgroundImage = "";
                if (!avatarEl.innerHTML.trim()) {
                    avatarEl.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
                }
            }
        }

        // Genre badges on settings card
        if (genreWrap) {
            if (genres.length) {
                const labels = { accion:"Acción", comedia:"Comedia", romance:"Romance", isekai:"Isekai",
                    shounen:"Shōnen", aventura:"Aventura", fantasia:"Fantasía", drama:"Drama",
                    terror:"Terror", misterio:"Misterio" };
                genreWrap.innerHTML = genres.map(g =>
                    `<span class="cfg-genre-badge">${labels[g] || g}</span>`
                ).join("");
                genreWrap.classList.add("has-genres");
            } else {
                genreWrap.innerHTML = "";
                genreWrap.classList.remove("has-genres");
            }
        }
    },

    _compressPhoto(file, callback) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const MAX = 440;
                let w = img.width, h = img.height;
                if (w > h) { if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; } }
                else       { if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; } }
                const canvas = document.createElement("canvas");
                canvas.width = w; canvas.height = h;
                canvas.getContext("2d").drawImage(img, 0, 0, w, h);
                callback(canvas.toDataURL("image/jpeg", 0.78));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    },

    setup() {
        // Build genre chips (multi-select, max 2)
        const genreWrap = $("pe-genre-chips");
        if (genreWrap) {
            genreWrap.innerHTML = this._GENRES.map(g =>
                `<button class="pe-genre-chip" data-genre="${g.id}">${g.label}</button>`
            ).join("");
            genreWrap.addEventListener("click", (e) => {
                const chip = e.target.closest(".pe-genre-chip");
                if (!chip) return;
                const isActive  = chip.classList.contains("active");
                const activeNow = genreWrap.querySelectorAll(".pe-genre-chip.active").length;

                if (isActive) {
                    chip.classList.remove("active");
                } else if (activeNow >= 2) {
                    // Shake the container and notify
                    genreWrap.classList.remove("shake");
                    void genreWrap.offsetWidth; // reflow to restart animation
                    genreWrap.classList.add("shake");
                    showToast("Máximo 2 géneros favoritos");
                    genreWrap.addEventListener("animationend", () => genreWrap.classList.remove("shake"), { once: true });
                    return;
                } else {
                    chip.classList.add("active");
                }
                this._updateGenreCount();
            });
        }

        // Back
        const backBtn = $("pe-back-btn");
        if (backBtn) backBtn.addEventListener("click", () => this.close());

        // Save
        const saveBtn = $("pe-save-btn");
        if (saveBtn) saveBtn.addEventListener("click", () => this.save());

        // Char counters — live update
        const uInput = $("pe-username");
        const bInput = $("pe-bio");
        if (uInput) uInput.addEventListener("input", () =>
            this._updateCharCount("pe-username-count", uInput.value.length, 28));
        if (bInput) bInput.addEventListener("input", () =>
            this._updateCharCount("pe-bio-count", bInput.value.length, 60));

        // Photo picker
        const photoInput = $("pe-photo-input");
        const avatarWrap = $("pe-avatar-wrap");
        if (avatarWrap && photoInput) {
            avatarWrap.addEventListener("click", () => photoInput.click());
            avatarWrap.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") photoInput.click();
            });
            photoInput.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (!file || !file.type.startsWith("image/")) return;
                this._compressPhoto(file, (compressed) => {
                    localStorage.removeItem("profile_photo");
                    localStorage.setItem("profile_photo", compressed);
                    this._renderAvatarPreview(compressed);
                    photoInput.value = "";
                    showToast("Foto actualizada");
                });
            });
        }

        // Remove photo
        const removeBtn = $("pe-remove-photo-btn");
        if (removeBtn) {
            removeBtn.addEventListener("click", () => {
                localStorage.removeItem("profile_photo");
                this._renderAvatarPreview(null);
                this.applyToCard();
                showToast("Foto eliminada");
            });
        }

        // Apply saved data to the settings card immediately
        this.applyToCard();
    },
};

// ==================== APP INIT ====================
const App = {
    async init() {
        Recommendations.init();
        Navigation.setup();
        AIManager.setup();
        DetailOverlay.setup();
        Library.setup();
        Library.render();
        Search.setup();
        Settings.setup();
        ProfileEditor.setup();
        refreshProfileIntegrations();
        CategoryManager.setupScroll();
        HomeManager.bindFilterChips();
        UIBuilder.renderHistorySection();
        this.setupAntiRedirect();
        this.registerSW();
        this.setupPWA();

        await HomeManager.initializeSections(false);
        HomeManager.renderPersonalizedSection();
        AIManager.init();
    },

    // ══════════════════════════════════════════════════════════════════
    // ANTI-REDIRECT ENGINE — 4 capas adicionales al sandbox del iframe
    // ══════════════════════════════════════════════════════════════════
    setupAntiRedirect() {
        const playerIsOpen = () => !!document.querySelector('#overlay-player.active');

        // ── Capa 3: bloquear window.open() del contexto padre ──────────
        // (el sandbox bloquea los del iframe; esto cubre scripts mismos-origen)
        const _origOpen = window.open.bind(window);
        window.open = function (...args) {
            if (playerIsOpen()) {
                showToast('🛡 Redirección bloqueada');
                return null;
            }
            return _origOpen(...args);
        };

        // ── Capa 4: interceptar navegación del top-frame ───────────────
        // Si algo intenta salir de la PWA mientras el player está abierto,
        // cancelamos el unload. returnValue no vacío garantiza el diálogo
        // "¿Salir?" en Chrome/Samsung Internet.
        window.addEventListener('beforeunload', (e) => {
            if (playerIsOpen()) {
                e.preventDefault();
                e.returnValue = 'AnimeSAO';
                return e.returnValue;
            }
        });

        // ── Capa 5: trampa de historial ────────────────────────────────
        // Algunos iframes llaman history.back() / history.go(-1) para
        // forzar navegación. Esto los atrapa y los ignora.
        history.replaceState({ animesao: true }, '', location.href);
        window.addEventListener('popstate', () => {
            if (playerIsOpen()) {
                history.pushState({ animesao: true }, '', location.href);
                showToast('🛡 Navegación bloqueada');
            }
        });

        // ── Capa 6: mutación de location desde mismo contexto ──────────
        // Override location.href setter via Object.defineProperty para
        // capturar cualquier intento directo de redirección
        try {
            const _desc = Object.getOwnPropertyDescriptor(window, 'location');
            if (!_desc || _desc.configurable) {
                // location no es reemplazable en la mayoría de browsers, pero
                // interceptamos la asignación a location.href
                const _loc = window.location;
                const _hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
                if (_hrefDesc && _hrefDesc.set) {
                    const _origSet = _hrefDesc.set;
                    Object.defineProperty(Location.prototype, 'href', {
                        get: _hrefDesc.get,
                        set(value) {
                            if (playerIsOpen() && typeof value === 'string' &&
                                !value.startsWith(location.origin) &&
                                !value.startsWith('/')) {
                                showToast('🛡 Redirección externa bloqueada');
                                return;
                            }
                            _origSet.call(this, value);
                        },
                        configurable: true,
                    });
                }
            }
        } catch (_) { /* silently fail if not configurable */ }

        // ── Capa 7: re-escudo automático por blur (SEGUNDO TOQUE) ──────
        // Cuando el usuario toca dentro del iframe, el foco pasa al iframe
        // y la ventana padre dispara `blur`. Aprovechamos ese momento para
        // re-activar el escudo ~80ms después (el iframe ya procesó el touch),
        // bloqueando el siguiente toque que los scripts de anuncios esperan.
        window.addEventListener('blur', () => {
            if (!playerIsOpen()) return;
            setTimeout(() => {
                // Sólo re-activar si el player sigue abierto
                if (playerIsOpen()) PlayerOverlay._activateShield(700);
            }, 80);
        });

        // ── Capa 8: recuperación tras visibilitychange ─────────────────
        // Si a pesar de todo se abrió otra pestaña/app y el usuario volvió,
        // re-activamos el escudo 2 s para evitar que la misma secuencia
        // vuelva a ocurrir de inmediato.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && playerIsOpen()) {
                PlayerOverlay._activateShield(2000);
                showToast('🛡 Protección anti-redirect reactivada');
            }
        });
    },
    // ══════════════════════════════════════════════════════════════════

    registerSW() {
        if ("serviceWorker" in navigator) {
            window.addEventListener("load", () => {
                navigator.serviceWorker
                    .register("/sw.js")
                    .catch((err) =>
                        console.error("[SW] Error al registrar", err),
                    );
            });
        }
    },

    setupPWA() {
        window.addEventListener("beforeinstallprompt", (e) => {
            e.preventDefault();
            AppState.deferredPrompt = e;
            const installBtn = $("btn-install-app");
            if (installBtn) {
                installBtn.style.display = "flex";
                installBtn.onclick = async () => {
                    if (AppState.deferredPrompt) {
                        AppState.deferredPrompt.prompt();
                        await AppState.deferredPrompt.userChoice;
                        AppState.deferredPrompt = null;
                        installBtn.style.display = "none";
                    }
                };
            }
        });

        window.addEventListener("appinstalled", () => {
            AppState.deferredPrompt = null;
            const installBtn = $("btn-install-app");
            if (installBtn) installBtn.style.display = "none";
            showToast("¡App instalada con éxito!");
        });
    },
};

document.addEventListener("DOMContentLoaded", () => {
    App.init();
});

document.addEventListener("contextmenu", (e) => {
    if (e.target.tagName === "IMG") e.preventDefault();
});

window.showToast = showToast;
window.Navigation = Navigation;
