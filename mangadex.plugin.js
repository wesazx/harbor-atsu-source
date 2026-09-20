// MangaDex (English) plugin for Harbor Stremio reader.
// Connects to the official MangaDex REST API v5 with built-in request throttling
// to avoid HTTP 429 rate limiting and ensure 100% complete chapter/page loading.

const MANGADEX_API = "https://api.mangadex.org";
const MANGADEX_UPLOADS = "https://uploads.mangadex.org";
const PAGE_SIZE = 48;
const MAX_CHAPTERS = 5000;
const TIMEOUT_MS = 30000;
const MIN_REQUEST_INTERVAL_MS = 260; // MangaDex limit is ~5 req/s (200ms). 260ms guarantees safety.

const HEADERS = {
  accept: "application/json",
  "user-agent": "Harbor-MangaDex/1.0.0"
};

let lastRequestTime = 0;

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await delay(MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function buildUrl(path, params) {
  const url = new URL(path, MANGADEX_API);
  for (const pair of params || []) {
    if (pair[1] !== undefined && pair[1] !== null && pair[1] !== "") {
      url.searchParams.append(pair[0], String(pair[1]));
    }
  }
  return url.toString();
}

async function requestJson(url, allowNotFound) {
  let finalStatus = "network";
  let finalMessage = "Invalid response";

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await throttle();
    let response = null;
    try {
      response = await harbor.http(url, {
        headers: HEADERS,
        responseType: "text",
        timeoutMs: TIMEOUT_MS
      });
    } catch (error) {
      finalMessage = nonEmptyString(error && error.message) || String(error);
    }

    if (allowNotFound && response && response.status === 404) return null;

    let payload = null;
    try {
      payload = response && response.body ? JSON.parse(response.body) : null;
    } catch (_error) {
      payload = null;
    }

    if (response && response.ok && payload) return payload;

    finalStatus = response && response.status ? response.status : "network";
    finalMessage = (payload && (payload.message || (payload.errors && payload.errors[0] && payload.errors[0].detail))) || finalMessage;

    const is429 = response && response.status === 429;
    const isRetryable = !response || is429 || response.status >= 500 || (response.ok && !payload);

    if (attempt < 3 && isRetryable) {
      const waitTime = is429 ? 2000 + attempt * 1000 : 500 * Math.pow(2, attempt);
      harbor.log("MangaDex throttled or error, waiting " + waitTime + "ms", url, finalStatus);
      await delay(waitTime);
      continue;
    }
    break;
  }

  harbor.log("MangaDex request failed", url, finalStatus, finalMessage);
  throw new Error("MangaDex request failed (" + finalStatus + "): " + finalMessage);
}

function pickLocalizedText(obj, preferredLangs) {
  if (!obj || typeof obj !== "object") return "";
  for (const lang of preferredLangs) {
    if (obj[lang]) return String(obj[lang]);
  }
  const firstKey = Object.keys(obj)[0];
  return firstKey && obj[firstKey] ? String(obj[firstKey]) : "";
}

function normalizeStatus(value) {
  const s = nonEmptyString(value).toLowerCase();
  if (s === "ongoing") return "ongoing";
  if (s === "completed") return "completed";
  if (s === "hiatus") return "hiatus";
  if (s === "cancelled") return "cancelled";
  return s;
}

function summaryFromMangaData(item) {
  if (!item || !item.id || !item.attributes) return null;
  const attr = item.attributes;
  const preferredLangs = ["en", "ja-ro", "ja", "ko", "zh"];

  const title = pickLocalizedText(attr.title, preferredLangs) || "Untitled";
  const altTitles = Array.isArray(attr.altTitles) ? attr.altTitles : [];
  let altTitle = "";
  for (const altObj of altTitles) {
    const candidate = pickLocalizedText(altObj, preferredLangs);
    if (candidate && candidate.toLowerCase() !== title.toLowerCase()) {
      altTitle = candidate;
      break;
    }
  }

  // Cover image from relationships
  let coverFileName = "";
  let authorName = "";
  const relationships = Array.isArray(item.relationships) ? item.relationships : [];
  for (const rel of relationships) {
    if (rel.type === "cover_art" && rel.attributes && rel.attributes.fileName) {
      coverFileName = rel.attributes.fileName;
    } else if ((rel.type === "author" || rel.type === "artist") && rel.attributes && rel.attributes.name) {
      if (!authorName) {
        authorName = rel.attributes.name;
      } else if (!authorName.includes(rel.attributes.name)) {
        authorName += ", " + rel.attributes.name;
      }
    }
  }

  const coverUrl = coverFileName
    ? MANGADEX_UPLOADS + "/covers/" + item.id + "/" + coverFileName + ".512.jpg"
    : undefined;

  const description = pickLocalizedText(attr.description, ["en", "ja-ro", "ja"]);
  const year = attr.year ? Number(attr.year) : undefined;
  const status = normalizeStatus(attr.status);
  const rating = nonEmptyString(attr.contentRating).toLowerCase() || "safe";

  const summary = {
    id: String(item.id),
    title: title
  };

  if (altTitle) summary.altTitle = altTitle;
  if (coverUrl) summary.cover = coverUrl;
  if (year && Number.isInteger(year)) summary.year = year;
  if (status) summary.status = status;
  if (description) summary.description = description;
  summary.contentRating = rating === "pornographic" || rating === "erotica" ? "adult" : rating;
  if (authorName) summary.author = authorName;
  if (attr.lastChapter) summary.lastChapter = String(attr.lastChapter);

  return summary;
}

const plugin = {
  id: "mangadex-en",
  name: "MangaDex (English)",

  async popular(offset, tagId) {
    const itemOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const params = [
      ["limit", PAGE_SIZE],
      ["offset", itemOffset],
      ["includes[]", "cover_art"],
      ["includes[]", "author"],
      ["availableTranslatedLanguage[]", "en"],
      ["hasAvailableChapters", "true"],
      ["order[followedCount]", "desc"],
      ["contentRating[]", "safe"],
      ["contentRating[]", "suggestive"]
    ];

    if (tagId && tagId.startsWith("tag:")) {
      params.push(["includedTags[]", tagId.slice(4)]);
    }

    const payload = await requestJson(buildUrl("/manga", params));
    const results = [];
    for (const item of Array.isArray(payload.data) ? payload.data : []) {
      const summary = summaryFromMangaData(item);
      if (summary) results.push(summary);
    }
    return results;
  },

  async search(query, offset, tagId) {
    const normalizedQuery = nonEmptyString(query);
    if (!normalizedQuery) return this.popular(offset, tagId);

    const itemOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const params = [
      ["limit", PAGE_SIZE],
      ["offset", itemOffset],
      ["title", normalizedQuery],
      ["includes[]", "cover_art"],
      ["includes[]", "author"],
      ["availableTranslatedLanguage[]", "en"],
      ["hasAvailableChapters", "true"],
      ["order[relevance]", "desc"],
      ["contentRating[]", "safe"],
      ["contentRating[]", "suggestive"]
    ];

    if (tagId && tagId.startsWith("tag:")) {
      params.push(["includedTags[]", tagId.slice(4)]);
    }

    const payload = await requestJson(buildUrl("/manga", params));
    const results = [];
    for (const item of Array.isArray(payload.data) ? payload.data : []) {
      const summary = summaryFromMangaData(item);
      if (summary) results.push(summary);
    }
    return results;
  },

  async detail(id) {
    const mangaId = String(id);
    const params = [
      ["includes[]", "cover_art"],
      ["includes[]", "author"]
    ];
    const payload = await requestJson(buildUrl("/manga/" + mangaId, params), true);
    return payload && payload.data ? summaryFromMangaData(payload.data) : null;
  },

  async chapters(id) {
    const mangaId = String(id);
    const chapters = [];
    const seenChapterIds = new Set();
    const limit = 100;
    let offset = 0;
    let total = 1;

    while (offset < total && chapters.length < MAX_CHAPTERS) {
      const params = [
        ["limit", limit],
        ["offset", offset],
        ["translatedLanguage[]", "en"],
        ["order[chapter]", "desc"],
        ["order[volume]", "desc"],
        ["includes[]", "scanlation_group"],
        ["includeExternalUrl", "0"],
        ["contentRating[]", "safe"],
        ["contentRating[]", "suggestive"],
        ["contentRating[]", "erotica"]
      ];

      const payload = await requestJson(buildUrl("/manga/" + mangaId + "/feed", params), true);
      if (!payload || !Array.isArray(payload.data)) break;

      total = Number(payload.total) || 0;
      const items = payload.data;
      if (items.length === 0) break;

      for (const item of items) {
        if (!item || !item.id || seenChapterIds.has(String(item.id))) continue;
        const attr = item.attributes || {};
        if (attr.externalUrl) continue;
        const pages = Number(attr.pages);
        if (!Number.isInteger(pages) || pages <= 0) continue;

        seenChapterIds.add(String(item.id));

        // Find scanlation group name
        let groupName = "";
        for (const rel of Array.isArray(item.relationships) ? item.relationships : []) {
          if (rel.type === "scanlation_group" && rel.attributes && rel.attributes.name) {
            groupName = rel.attributes.name;
            break;
          }
        }

        const chapter = {
          id: String(item.id),
          chapter: attr.chapter !== undefined && attr.chapter !== null ? String(attr.chapter) : null,
          volume: attr.volume !== undefined && attr.volume !== null ? String(attr.volume) : null,
          pages: Number.isInteger(pages) && pages >= 0 ? pages : 0,
          language: "en"
        };

        const title = nonEmptyString(attr.title);
        if (title) chapter.title = title;
        if (groupName) chapter.group = groupName;
        if (attr.publishAt) chapter.publishAt = String(attr.publishAt);

        chapters.push(chapter);
        if (chapters.length >= MAX_CHAPTERS) break;
      }

      offset += limit;
      // MangaDex feed pagination throttling: small pause between pages
      if (offset < total) {
        await delay(200);
      }
    }

    return chapters;
  },

  async pageUrls(chapterId) {
    const chapId = String(chapterId);
    if (!chapId) return [];

    const payload = await requestJson(buildUrl("/at-home/server/" + chapId, []), true);
    if (!payload || !payload.baseUrl || !payload.chapter || !payload.chapter.hash) {
      return [];
    }

    const baseUrl = payload.baseUrl;
    const hash = payload.chapter.hash;
    const files = Array.isArray(payload.chapter.data) ? payload.chapter.data : [];

    const urls = [];
    for (const file of files) {
      if (file) {
        urls.push(baseUrl + "/data/" + hash + "/" + file);
      }
    }
    return urls;
  },

  async tags() {
    try {
      const payload = await requestJson(buildUrl("/manga/tag", []), true);
      const tags = [];
      for (const item of Array.isArray(payload && payload.data) ? payload.data : []) {
        if (!item || !item.id || !item.attributes) continue;
        const name = pickLocalizedText(item.attributes.name, ["en"]);
        const group = nonEmptyString(item.attributes.group) || "Genre";
        if (name) {
          tags.push({
            id: "tag:" + item.id,
            name: name,
            group: group.charAt(0).toUpperCase() + group.slice(1)
          });
        }
      }
      tags.sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
      return tags;
    } catch (_error) {
      return [];
    }
  }
};

harbor.register(plugin);
