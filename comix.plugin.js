/*
 * Harbor manga source for Comix.
 *
 * Request signing and response decoding are ported from the MIT-licensed
 * Comix connector maintained at:
 * https://github.com/N3uralCreativity/comix-downloader
 */

const BASE = "https://comix.to";
const API = BASE + "/api/v1";
const PAGE_SIZE = 28;
const MAX_CHAPTER_PAGES = 50;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LAYER_DATA = [
  {
    sbox: "gbicCvAMzfcXEtGAyjvvhmb2yCWzWhjqcxXZ7ZhpzANOzoQLo3nuPZ2vK9dkb9hJExC0Vni/hdQBceI+mw611gkhQFjBuf4bJg1TxYqM+SL4YDqtwjxiGSdeH7so7Fn1HiRo37Z+RNvl44twXWVhomtMjw+8bemfmv9XEXr7mS82MxaCOJZRR0oHd9PLI5O+gyBGT6hcLoduNa7yCObVVCk3bFWsoD+xcqTrBcP6dNJN/NB1Br2QGhSN2snHAqeRNKVFQiyeAFLPSKGwY8aq9EPgsi17qd4ywPMxiH8w6N1qX1tLKtzhOeemHWeJQfFQ5H23q7qSlJUcjgTEl3x2/Q==",
    key: "rafYl4oSAKQX+GYoic9oW4iGwiYpZzs0",
    iv: 189,
  },
  {
    sbox: "2lQehmgyYFAoWUi0haazZqHy5zZ34NN+VzlfsoB2Y1yY0IuMLjgVcV2xt8t4moH+AP0NMJ5qekW7DFIHEWKkOgIBIMhDdA8lbM6iHKjDlq6IChpb3CnA9NmsvQW/afdt1SfJjTdwcvpKqunCJLxBFmXX9hecm6tGb+HRxD7BC3njoxPxgnX5pdKP1IMSkd4/O3NRfZSE6DVLG2s9uexaipA05cpJzE8Qkv/z5jzHAwlEWOLd3yxA+0cvVbpOoJPFGc8f1lb4vu2HUxjuuEwEQk0GsPCVnyKvfOoh9TG2YYmZLV4I67UU2NsrrakqZ47k/O+ne25/DjPGZCMdnZcmzQ==",
    key: "2USAq+VTo5ht4bQn+K9DUcpUQRTtrB56",
    iv: 133,
  },
  {
    sbox: "+mhJSFwzaV+PQPDyKp2scO/S9SdFsy/7e56UWT8XHbK3E2+19nEPwfwOgE9uVCaDtOAWTobCZX+cBCXlIbBqyDyQB1beKLspW6kGPhBCV9x0jf0KUeFhHjmlMf7qMFIB41PfDFprZ3bJiK4YxrZDv+K6dcwJmggVO8f5ktrXTM0cZL4fer0SpnkbvNajPbHxfuTz5lVEBarOI4rdc+2V6zTsjpfQYjgN1MMr6EvA6eehN6dQ1bgUogt9rZOBbQBeNnLYY00uZqSoJBnFi5gthCJsWF33ykosn9v/9KB8udMCz0YRYImrA4VHr5mMgpH4xDXLeEHRd5vZOiAalofuMg==",
    key: "yNHlokVEnuecesDrB/lDhVuUNiheWc3a47VtkwZ2ENg=",
    iv: 32,
  },
];

function decodeBase64(value) {
  const binary = atob(String(value).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(offset, offset + 0x8000);
    for (let index = 0; index < chunk.length; index++) binary += String.fromCharCode(chunk[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const LAYERS = LAYER_DATA.map((item) => {
  const sbox = decodeBase64(item.sbox);
  const inverse = new Uint8Array(256);
  for (let index = 0; index < sbox.length; index++) inverse[sbox[index]] = index;
  return { sbox, inverse, key: decodeBase64(item.key), iv: item.iv };
});

function encodeToken(input) {
  let bytes = new TextEncoder().encode(input);
  for (const layer of LAYERS) {
    const output = new Uint8Array(bytes.length);
    let previous = layer.iv;
    for (let index = 0; index < bytes.length; index++) {
      const value = layer.sbox[(bytes[index] ^ layer.key[index % layer.key.length] ^ previous) & 255];
      output[index] = value;
      previous = value;
    }
    bytes = output;
  }
  return encodeBase64Url(bytes);
}

function decodeEnvelope(token) {
  let bytes = decodeBase64(token);
  for (let layerIndex = LAYERS.length - 1; layerIndex >= 0; layerIndex--) {
    const layer = LAYERS[layerIndex];
    const output = new Uint8Array(bytes.length);
    let previous = layer.iv;
    for (let index = 0; index < bytes.length; index++) {
      const cipher = bytes[index];
      output[index] = (layer.inverse[cipher] ^ layer.key[index % layer.key.length] ^ previous) & 255;
      previous = cipher;
    }
    bytes = output;
  }
  return new TextDecoder().decode(bytes);
}

function signedUrl(path, entries) {
  const cleanPath = path.startsWith("/") ? path : "/" + path;
  const sorted = (entries || [])
    .filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== "")
    .map((entry) => [String(entry[0]), String(entry[1])])
    .sort((left, right) => left[0].localeCompare(right[0]));
  const canonical = sorted.map((entry) => entry[0] + "=" + entry[1]).join("&");
  const token = encodeToken(canonical ? cleanPath + "?" + canonical : cleanPath);
  const query = new URLSearchParams();
  for (const [key, value] of sorted) query.append(key, value);
  query.append("_", token);
  return API + cleanPath + "?" + query.toString();
}

async function api(path, entries) {
  const response = await harbor.http(signedUrl(path, entries), {
    headers: { Accept: "application/json, text/plain, */*" },
    responseType: "text",
    timeoutMs: 15000,
  });
  if (!response || !response.ok) {
    throw new Error("Comix request failed" + (response ? " (HTTP " + response.status + ")" : ""));
  }
  let data;
  try {
    data = JSON.parse(response.body);
    if (data && typeof data.e === "string") data = JSON.parse(decodeEnvelope(data.e));
  } catch (_error) {
    throw new Error("Comix returned an unreadable response");
  }
  if (!data || data.error) throw new Error((data && data.message) || "Comix request failed");
  return data.result === undefined ? data : data.result;
}

function toSummary(item) {
  if (!item || !item.hid || !item.title) return null;
  const poster = item.poster || {};
  const altTitles = Array.isArray(item.altTitles) ? item.altTitles : [];
  return {
    id: String(item.hid),
    title: String(item.title),
    altTitle: altTitles.length ? String(altTitles[0]) : undefined,
    cover: poster.large || poster.medium || poster.small || undefined,
    year: Number.isFinite(item.year) ? Number(item.year) : undefined,
    status: item.status || undefined,
    description: item.synopsis || undefined,
    contentRating: item.contentRating || undefined,
    lastChapter: item.latestChapter == null ? undefined : String(item.latestChapter),
  };
}

function mangaEntries(offset, query, tagId) {
  const page = Math.floor(Math.max(0, Number(offset) || 0) / PAGE_SIZE) + 1;
  const entries = [["limit", PAGE_SIZE], ["page", page]];
  if (query) entries.push(["keyword", query], ["order[relevance]", "desc"]);
  else entries.push(["order[score]", "desc"]);
  if (tagId) entries.push(["genres[]", tagId]);
  return entries;
}

async function chapterPage(mangaId, page) {
  return api("/manga/" + encodeURIComponent(mangaId) + "/chapters", [
    ["limit", 100],
    ["page", page],
    ["order[number]", "desc"],
  ]);
}

function toChapter(item) {
  const group = item && item.group;
  const number = item && item.number;
  return {
    id: String(item.id),
    chapter: number == null ? null : String(number).replace(/\.0$/, ""),
    title: item.name || undefined,
    volume: item.volume == null ? null : String(item.volume),
    pages: Number.isInteger(item.pagesCount) && item.pagesCount >= 0 ? item.pagesCount : 0,
    language: item.language || "en",
    group: group && group.name ? group.name : item.isOfficial ? "Official" : undefined,
    publishAt: item.createdAt || item.publishedAt || undefined,
  };
}

const plugin = {
  id: "comix-en",
  name: "Comix.to (English)",

  async popular(offset, tagId) {
    const result = await api("/manga", mangaEntries(offset, "", tagId));
    return (Array.isArray(result.items) ? result.items : []).map(toSummary).filter(Boolean);
  },

  async search(query, offset, tagId) {
    const text = String(query || "").trim();
    const result = await api("/manga", mangaEntries(offset, text, tagId));
    return (Array.isArray(result.items) ? result.items : []).map(toSummary).filter(Boolean);
  },

  async detail(id) {
    const item = await api("/manga/" + encodeURIComponent(id));
    const summary = toSummary(item);
    if (!summary) return null;
    const creators = [];
    for (const author of Array.isArray(item.authors) ? item.authors : []) {
      if (author && author.title) creators.push(author.title);
    }
    for (const artist of Array.isArray(item.artists) ? item.artists : []) {
      if (artist && artist.title) creators.push(artist.title);
    }
    return { ...summary, author: [...new Set(creators)].join(", ") || undefined };
  },

  async chapters(id) {
    const first = await chapterPage(id, 1);
    const items = Array.isArray(first.items) ? first.items.slice() : [];
    const lastPage = Math.min(
      MAX_CHAPTER_PAGES,
      Math.max(1, Number(first.meta && first.meta.lastPage) || 1),
    );
    for (let start = 2; start <= lastPage; start += 5) {
      const requests = [];
      for (let page = start; page < Math.min(start + 5, lastPage + 1); page++) {
        requests.push(chapterPage(id, page));
      }
      const results = await Promise.all(requests);
      for (const result of results) {
        if (Array.isArray(result.items)) items.push(...result.items);
      }
    }
    const seen = new Set();
    const chapters = items.map(toChapter).filter((chapter) => {
      if (!chapter.id || seen.has(chapter.chapter)) return false;
      seen.add(chapter.chapter);
      return true;
    });
    return chapters.sort((left, right) => {
      const leftNumber = Number.parseFloat(left.chapter || "");
      const rightNumber = Number.parseFloat(right.chapter || "");
      const a = Number.isFinite(leftNumber) ? leftNumber : Number.NEGATIVE_INFINITY;
      const b = Number.isFinite(rightNumber) ? rightNumber : Number.NEGATIVE_INFINITY;
      return a - b;
    });
  },

  async pageUrls(chapterId) {
    const result = await api("/chapters/" + encodeURIComponent(chapterId));
    const pages = result && result.pages ? result.pages : {};
    const baseUrl = String(pages.baseUrl || "").replace(/\/+$/, "");
    return (Array.isArray(pages.items) ? pages.items : []).map((item) => {
      const url = typeof item === "string" ? item : item && item.url;
      if (!url) return null;
      const absolute = /^https?:\/\//i.test(url)
        ? url
        : baseUrl + "/" + String(url).replace(/^\/+/, "");
      return {
        url: absolute,
        headers: {
          Referer: BASE + "/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Harbor/1.0",
        },
      };
    }).filter(Boolean);
  },
};


harbor.register(plugin);
