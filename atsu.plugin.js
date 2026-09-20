// Atsu source for Harbor.
// Uses only Harbor's worker bridge and Atsu's public web endpoints.

const ATSU_ORIGIN = "https://atsu.moe";
const MANGA_PAGE = 48;
const MAX_CHAPTERS = 5000;
const SEARCH_FIELDS = "title,englishTitle,otherNames,authors,acronyms";
const SEARCH_WEIGHTS = "4,3,2,1,1";
const SEARCH_TYPOS = "4,3,2,1,0";
const SEARCH_PREFIX = "true,true,true,true,false";
const SEARCH_INFIX = "off,off,fallback,off,off";
const SUMMARY_FIELDS = [
  "id",
  "title",
  "englishTitle",
  "poster",
  "posterSmall",
  "posterMedium",
  "type",
  "medium",
  "isAdult",
  "mbContentRating",
  "status",
  "year",
  "authors",
  "synopsis",
  "chapterCount",
  "popularity",
  "dateAdded"
].join(",");
const HEADERS = {
  accept: "application/json",
  "user-agent": "Harbor-Atsu/1.0.0"
};

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function absoluteMediaUrl(value) {
  const source = nonEmptyString(value);
  if (!source) return "";
  if (/^https?:\/\//i.test(source)) return source;
  if (source.slice(0, 2) === "//") return "https:" + source;

  let path = source.replace(/^\/+/, "");
  if (path.slice(0, 7) !== "static/") path = "static/" + path;
  return ATSU_ORIGIN + "/" + path;
}

function buildUrl(path, params) {
  const url = new URL(path, ATSU_ORIGIN);
  for (const pair of params || []) {
    if (pair[1] !== undefined && pair[1] !== null && pair[1] !== "") {
      url.searchParams.append(pair[0], String(pair[1]));
    }
  }
  return url.toString();
}

function delay(milliseconds) {
  return new Promise(function (resolve) {
    setTimeout(resolve, milliseconds);
  });
}

const TIMEOUT_MS = 30000;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 200;

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await delay(MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

async function requestJsonUrl(url, allowNotFound) {
  let finalStatus = "network";
  let finalMessage = "Invalid response";

  for (let attempt = 0; attempt < 3; attempt += 1) {
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
    finalMessage = (payload && nonEmptyString(payload.error || payload.message)) || finalMessage;
    const retryable = !response || response.status === 429 || response.status >= 500 ||
      (response.ok && !payload);
    if (attempt < 2 && retryable) {
      const backoff = 400 * Math.pow(2, attempt);
      await delay(backoff);
      continue;
    }
    break;
  }

  harbor.log("Atsu request failed", url, finalStatus, finalMessage);
  throw new Error("Atsu request failed (" + finalStatus + "): " + finalMessage);
}

function requestJson(path, params, allowNotFound) {
  return requestJsonUrl(buildUrl(path, params), allowNotFound);
}

function filterValue(value) {
  return "`" + String(value).replace(/`/g, "\\`") + "`";
}

function catalogueUrl(query, offset, tagId, popular) {
  const normalizedQuery = nonEmptyString(query);
  const itemOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const filters = [
    "medium:=" + filterValue("Comic"),
    "isAdult:=false",
    "hidden:!=true"
  ];

  const selectedTag = nonEmptyString(tagId);
  if (selectedTag.slice(0, 6) === "genre:" && selectedTag.length > 6) {
    filters.push("genreIds:=" + filterValue(selectedTag.slice(6)));
  }
  if (popular) filters.push("views:>0");

  const params = [
    ["q", normalizedQuery || "*"],
    ["query_by", SEARCH_FIELDS],
    ["query_by_weights", SEARCH_WEIGHTS],
    ["num_typos", SEARCH_TYPOS],
    ["prefix", SEARCH_PREFIX],
    ["include_fields", SUMMARY_FIELDS],
    ["filter_by", filters.join(" && ")],
    ["page", Math.floor(itemOffset / MANGA_PAGE) + 1],
    ["per_page", MANGA_PAGE]
  ];

  if (normalizedQuery) params.push(["infix", SEARCH_INFIX]);
  else params.push(["sort_by", "views:desc"]);

  return buildUrl("/collections/manga/documents/search", params);
}

function normalizeStatus(value) {
  const status = nonEmptyString(value).toLowerCase();
  if (status === "canceled") return "cancelled";
  return status;
}

function authorNames(value) {
  const names = [];
  for (const author of Array.isArray(value) ? value : []) {
    const name = nonEmptyString(typeof author === "string" ? author : author && author.name);
    if (name && names.indexOf(name) === -1) names.push(name);
  }
  return names;
}

function summaryFromDocument(record) {
  const primary = nonEmptyString(record && record.englishTitle) ||
    nonEmptyString(record && record.title) || "Untitled";
  const original = nonEmptyString(record && record.title);
  const summary = {
    id: String(record.id),
    title: primary
  };

  if (original && original.toLocaleLowerCase() !== primary.toLocaleLowerCase()) {
    summary.altTitle = original;
  }

  const cover = absoluteMediaUrl(
    record.poster || record.posterMedium || record.posterSmall
  );
  if (cover) summary.cover = cover;

  const year = Number(record.year);
  if (Number.isInteger(year) && year > 0) summary.year = year;

  const status = normalizeStatus(record.status);
  if (status) summary.status = status;

  const description = nonEmptyString(record.synopsis);
  if (description) summary.description = description;

  const rating = nonEmptyString(record.mbContentRating);
  summary.contentRating = record.isAdult ? "adult" : (rating.toLowerCase() || "safe");

  const authors = authorNames(record.authors);
  if (authors.length) summary.author = authors.join(", ");
  return summary;
}

function summaryFromPage(page) {
  const primary = nonEmptyString(page.englishTitle) || nonEmptyString(page.title) || "Untitled";
  const original = nonEmptyString(page.title);
  const summary = {
    id: String(page.id),
    title: primary,
    contentRating: page.isAdult ? "adult" : "safe"
  };

  if (original && original.toLocaleLowerCase() !== primary.toLocaleLowerCase()) {
    summary.altTitle = original;
  } else {
    for (const candidate of Array.isArray(page.otherNames) ? page.otherNames : []) {
      const alternative = nonEmptyString(candidate);
      if (alternative && alternative.toLocaleLowerCase() !== primary.toLocaleLowerCase()) {
        summary.altTitle = alternative;
        break;
      }
    }
  }

  const poster = page.poster || {};
  const cover = absoluteMediaUrl(poster.image || poster.mediumImage || poster.smallImage);
  if (cover) summary.cover = cover;

  const released = Number(page.released);
  if (Number.isFinite(released) && released > 0) {
    const year = new Date(released).getUTCFullYear();
    if (Number.isInteger(year) && year > 0) summary.year = year;
  }

  const status = normalizeStatus(page.status);
  if (status) summary.status = status;

  const description = nonEmptyString(page.synopsis);
  if (description) summary.description = description;

  const authors = authorNames(page.authors).filter(function (name, index, list) {
    return list.indexOf(name) === index;
  });
  if (authors.length) summary.author = authors.join(", ");

  for (const chapter of Array.isArray(page.chapters) ? page.chapters : []) {
    if (chapter && chapter.number !== undefined && chapter.number !== null) {
      summary.lastChapter = String(chapter.number);
      break;
    }
  }
  return summary;
}

function encodedChapterId(mangaId, chapterId) {
  return String(mangaId) + ":" + String(chapterId);
}

function decodedChapterId(value) {
  const encoded = String(value);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator >= encoded.length - 1) return null;
  return {
    mangaId: encoded.slice(0, separator),
    chapterId: encoded.slice(separator + 1)
  };
}

function isoTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  try {
    return new Date(timestamp).toISOString();
  } catch (_error) {
    return "";
  }
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const plugin = {
  id: "atsu-en",
  name: "Atsu (English)",

  async popular(offset, tagId) {
    const payload = await requestJsonUrl(catalogueUrl("", offset, tagId, true));
    const results = [];
    for (const hit of Array.isArray(payload.hits) ? payload.hits : []) {
      const record = hit && hit.document;
      if (record && record.id && (record.englishTitle || record.title)) {
        results.push(summaryFromDocument(record));
      }
    }
    return results;
  },

  async search(query, offset, tagId) {
    const normalizedQuery = nonEmptyString(query);
    if (!normalizedQuery) return this.popular(offset, tagId);

    const payload = await requestJsonUrl(catalogueUrl(normalizedQuery, offset, tagId, false));
    const results = [];
    for (const hit of Array.isArray(payload.hits) ? payload.hits : []) {
      const record = hit && hit.document;
      if (record && record.id && (record.englishTitle || record.title)) {
        results.push(summaryFromDocument(record));
      }
    }
    return results;
  },

  async detail(id) {
    const payload = await requestJson(
      "/api/manga/page",
      [["id", String(id)]],
      true
    );
    return payload && payload.mangaPage ? summaryFromPage(payload.mangaPage) : null;
  },

  async chapters(id) {
    const mangaId = String(id);
    const responses = await Promise.all([
      requestJson("/api/manga/allChapters", [["mangaId", mangaId]], true),
      requestJson("/api/manga/page", [["id", mangaId]], true).catch(function (error) {
        harbor.log("Atsu scanlator metadata unavailable", mangaId, String(error));
        return null;
      })
    ]);
    if (!responses[0] || !Array.isArray(responses[0].chapters)) return [];

    const groupById = new Map();
    const mangaPage = responses[1] && responses[1].mangaPage;
    for (const group of mangaPage && Array.isArray(mangaPage.scanlators)
      ? mangaPage.scanlators
      : []) {
      const groupId = nonEmptyString(group && group.id);
      const groupName = nonEmptyString(group && group.name);
      if (groupId && groupName) groupById.set(groupId, groupName);
    }

    const chapters = [];
    const seenChapterIds = new Set();
    const entities = responses[0].chapters.slice();
    entities.sort(function (a, b) {
      const aNumber = finiteNumber(a && a.number);
      const bNumber = finiteNumber(b && b.number);
      if (aNumber !== null && bNumber !== null && aNumber !== bNumber) return bNumber - aNumber;
      if ((aNumber !== null) !== (bNumber !== null)) return aNumber !== null ? -1 : 1;

      const aIndex = finiteNumber(a && a.index);
      const bIndex = finiteNumber(b && b.index);
      if (aIndex !== null && bIndex !== null && aIndex !== bIndex) {
        return bIndex - aIndex;
      }
      return (Number(b && b.createdAt) || 0) - (Number(a && a.createdAt) || 0);
    });

    for (const entity of entities) {
      if (chapters.length >= MAX_CHAPTERS) break;
      if (!entity || !entity.id || seenChapterIds.has(String(entity.id))) continue;
      seenChapterIds.add(String(entity.id));
      const pages = Number(entity.pageCount);
      const chapter = {
        id: encodedChapterId(mangaId, entity.id),
        chapter: entity.number === undefined || entity.number === null
          ? null
          : String(entity.number),
        pages: Number.isInteger(pages) && pages >= 0 ? pages : 0,
        language: "en"
      };

      const title = nonEmptyString(entity.title);
      if (title) chapter.title = title;

      const group = groupById.get(nonEmptyString(entity.scanlationMangaId));
      if (group) chapter.group = group;

      const published = isoTimestamp(entity.createdAt);
      if (published) chapter.publishAt = published;
      chapters.push(chapter);
    }
    return chapters;
  },

  async pageUrls(chapterId) {
    const decoded = decodedChapterId(chapterId);
    if (!decoded) return [];

    const payload = await requestJson("/api/read/chapter", [
      ["mangaId", decoded.mangaId],
      ["chapterId", decoded.chapterId]
    ]);
    const readChapter = payload && payload.readChapter;
    const pages = readChapter && Array.isArray(readChapter.pages)
      ? readChapter.pages.map(function (page, index) { return { page: page, index: index }; })
      : [];
    pages.sort(function (a, b) {
      const aNumber = finiteNumber(a.page && a.page.number);
      const bNumber = finiteNumber(b.page && b.page.number);
      if (aNumber !== null && bNumber !== null && aNumber !== bNumber) return aNumber - bNumber;
      if ((aNumber !== null) !== (bNumber !== null)) return aNumber !== null ? -1 : 1;
      return a.index - b.index;
    });

    const urls = [];
    for (const item of pages.slice(0, 2000)) {
      const url = absoluteMediaUrl(item.page && item.page.image);
      if (url) urls.push(url);
    }
    return urls;
  },

  async tags() {
    const payload = await requestJson("/api/explore/availableFilters");
    const excludedAdultGenres = new Set(["adult", "hentai", "smut"]);
    const tags = [];
    for (const genre of Array.isArray(payload.genres) ? payload.genres : []) {
      const id = nonEmptyString(genre && genre.id);
      const name = nonEmptyString(genre && genre.name);
      if (!id || !name || excludedAdultGenres.has(name.toLowerCase())) continue;
      tags.push({ id: "genre:" + id, name: name, group: "Genre" });
    }
    tags.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return tags;
  }
};

harbor.register(plugin);
