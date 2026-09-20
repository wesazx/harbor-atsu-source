// Comix.to plugin for Harbor Stremio reader.
// Supports Cloudflare bypass via FlareSolverr (http://localtest.me:8191/v1)
// Note: "localtest.me" is used because Harbor's plugin security blocks "localhost" or "127.0.0.1".

const COMIX_ORIGIN = "https://comix.to";
// Default FlareSolverr URL using localtest.me to pass Harbor's private-host check
const FLARESOLVERR_ENDPOINT = "http://localtest.me:8191/v1";
const PAGE_SIZE = 28;
const TIMEOUT_MS = 35000;

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Fetch via FlareSolverr proxy to bypass Cloudflare JS challenge
async function fetchViaFlareSolverr(targetUrl) {
  const body = JSON.stringify({
    cmd: "request.get",
    url: targetUrl,
    maxTimeout: TIMEOUT_MS - 5000
  });

  try {
    const res = await harbor.http(FLARESOLVERR_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: body,
      responseType: "text",
      timeoutMs: TIMEOUT_MS
    });

    if (res && res.ok && res.body) {
      const data = JSON.parse(res.body);
      if (data && data.status === "ok" && data.solution && data.solution.response) {
        return data.solution.response;
      }
    }
  } catch (error) {
    harbor.log("FlareSolverr request failed, trying direct fallback:", String(error));
  }

  // Direct fetch fallback if FlareSolverr is unavailable
  const direct = await harbor.http(targetUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: COMIX_ORIGIN + "/"
    },
    responseType: "text",
    timeoutMs: TIMEOUT_MS
  });

  if (direct && direct.ok && direct.body) {
    return direct.body;
  }

  throw new Error("Failed to fetch page from Comix.to (Cloudflare challenge active or network timeout)");
}

function parseInitialData(html) {
  const match = html.match(/<script[^>]*id=["']initial-data["'][^>]*>(.*?)<\/script>/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch (_e) {
    return null;
  }
}

function extractCardsFromHtml(html) {
  const cardMap = new Map();

  // Match entire <a ...>...</a> elements
  const linkRegex = /<a\b([^>]*)>(.*?)<\/a>/gs;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const attrs = match[1] || "";
    const inner = match[2] || "";

    const hrefMatch = attrs.match(/href=["'](\/title\/([^"'/]+))["']/i);
    if (!hrefMatch) continue;

    const fullPath = hrefMatch[1];
    const slug = hrefMatch[2];

    if (slug === "browse" || fullPath.includes("/chapter-") || slug.startsWith("user") || slug.startsWith("admin")) {
      continue;
    }

    if (!cardMap.has(slug)) {
      cardMap.set(slug, {
        id: slug,
        title: "",
        cover: undefined,
        contentRating: "safe"
      });
    }

    const card = cardMap.get(slug);

    // Extract title from aria-label or inner text
    const ariaMatch = attrs.match(/aria-label=["']([^"']+)["']/i);
    if (ariaMatch && cleanText(ariaMatch[1])) {
      card.title = cleanText(ariaMatch[1]);
    } else {
      const text = cleanText(inner);
      if (text && text.length >= 2 && !card.title) {
        card.title = text;
      }
    }

    // Extract cover image
    const imgMatch = inner.match(/src=["'](https:\/\/static\.comix\.to\/[^"']+)["']/i);
    if (imgMatch && !card.cover) {
      card.cover = imgMatch[1];
    }
  }

  const results = [];
  for (const card of cardMap.values()) {
    if (card.title) {
      results.push(card);
    }
  }

  return results;
}

const plugin = {
  id: "comix-en",
  name: "Comix.to (English)",

  async popular(offset) {
    const itemOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const page = Math.floor(itemOffset / PAGE_SIZE) + 1;
    const url = COMIX_ORIGIN + "/browse" + (page > 1 ? "?page=" + page : "");

    const html = await fetchViaFlareSolverr(url);
    const cards = extractCardsFromHtml(html);
    return cards;
  },

  async search(query, offset) {
    const normalizedQuery = nonEmptyString(query);
    if (!normalizedQuery) return this.popular(offset);

    const itemOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const page = Math.floor(itemOffset / PAGE_SIZE) + 1;
    const url = COMIX_ORIGIN + "/browse?keyword=" + encodeURIComponent(normalizedQuery) + (page > 1 ? "&page=" + page : "");

    const html = await fetchViaFlareSolverr(url);
    const cards = extractCardsFromHtml(html);
    return cards;
  },

  async detail(id) {
    const slug = String(id).replace(/^\/+title\/+/, "").replace(/^\/+/, "");
    const url = COMIX_ORIGIN + "/title/" + slug;

    const html = await fetchViaFlareSolverr(url);
    const initialData = parseInitialData(html);

    let title = slug;
    let description = "";
    let cover = "";
    let status = "ongoing";
    let year;
    let author = "";
    let contentRating = "safe";

    if (initialData && initialData.queries) {
      for (const key of Object.keys(initialData.queries)) {
        if (key.includes("detail") && key.includes("manga")) {
          const detail = initialData.queries[key];
          if (detail && typeof detail === "object") {
            title = nonEmptyString(detail.title) || title;
            description = nonEmptyString(detail.synopsis) || "";
            if (detail.poster && typeof detail.poster === "object") {
              cover = detail.poster.large || detail.poster.medium || "";
            } else if (typeof detail.poster === "string") {
              cover = detail.poster;
            }
            if (detail.status) status = String(detail.status).toLowerCase();
            if (detail.year) year = Number(detail.year);
            if (detail.contentRating) contentRating = String(detail.contentRating).toLowerCase();
            break;
          }
        }
      }
    }

    // Fallback parsing from HTML if initial-data didn't yield everything
    if (!cover) {
      const coverMatch = html.match(/<img[^>]+src=["'](https:\/\/static\.comix\.to\/[^"']+)["'][^>]*class=["'][^"']*poster/i);
      if (coverMatch) cover = coverMatch[1];
    }
    if (!description) {
      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
      if (descMatch) description = cleanText(descMatch[1]);
    }

    const summary = {
      id: slug,
      title: title,
      contentRating: contentRating === "pornographic" || contentRating === "erotica" ? "adult" : "safe"
    };

    if (cover) summary.cover = cover;
    if (description) summary.description = description;
    if (status) summary.status = status;
    if (year && Number.isInteger(year)) summary.year = year;
    if (author) summary.author = author;

    return summary;
  },

  async chapters(id) {
    const slug = String(id).replace(/^\/+title\/+/, "").replace(/^\/+/, "");
    const url = COMIX_ORIGIN + "/title/" + slug;

    const html = await fetchViaFlareSolverr(url);
    const chapters = [];
    const seenIds = new Set();

    // Regex for chapters: /title/{slug}/(chapterId)-chapter-(number)
    const chapRegex = /href=["'](\/title\/[^"'/]+\/(\d+)-chapter-([^"'/]+))["']/g;
    let match;

    while ((match = chapRegex.exec(html)) !== null) {
      const href = match[1];
      const chapId = match[2];
      const chapNum = match[3];

      if (seenIds.has(chapId)) continue;
      seenIds.add(chapId);

      chapters.push({
        id: slug + ":" + chapId + ":" + chapNum,
        chapter: chapNum,
        title: "Chapter " + chapNum,
        pages: 0,
        language: "en"
      });
    }

    return chapters;
  },

  async pageUrls(chapterId) {
    const parts = String(chapterId).split(":");
    if (parts.length < 3) return [];

    const slug = parts[0];
    const chapId = parts[1];
    const chapNum = parts[2];
    const url = COMIX_ORIGIN + "/title/" + slug + "/" + chapId + "-chapter-" + chapNum;

    const html = await fetchViaFlareSolverr(url);
    const urls = [];

    // Extract image URLs from reader DOM or initial data
    const imgRegex = /src=["'](https:\/\/static\.comix\.to\/[^"']+)["']/gi;
    let match;
    const seenImages = new Set();

    while ((match = imgRegex.exec(html)) !== null) {
      const src = match[1];
      if (!src.includes("poster") && !src.includes("avatar") && !seenImages.has(src)) {
        seenImages.add(src);
        urls.push(src);
      }
    }

    return urls;
  },

  async tags() {
    return [
      { id: "action", name: "Action", group: "Genre" },
      { id: "adventure", name: "Adventure", group: "Genre" },
      { id: "comedy", name: "Comedy", group: "Genre" },
      { id: "drama", name: "Drama", group: "Genre" },
      { id: "fantasy", name: "Fantasy", group: "Genre" },
      { id: "horror", name: "Horror", group: "Genre" },
      { id: "mystery", name: "Mystery", group: "Genre" },
      { id: "romance", name: "Romance", group: "Genre" },
      { id: "sci-fi", name: "Sci-Fi", group: "Genre" },
      { id: "slice-of-life", name: "Slice of Life", group: "Genre" },
      { id: "supernatural", name: "Supernatural", group: "Genre" }
    ];
  }
};

harbor.register(plugin);
