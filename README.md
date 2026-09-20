# Harbor Manga Sources 📚

An optimized, stable, and high-performance manga repository for the [Harbor Stremio Desktop Client](https://github.com/harborstremio/harbor).

This repository extends Harbor with robust providers for the most popular manga platforms, featuring built-in protections against network timeouts, API rate limits, and Cloudflare anti-bot challenges.

---

## 🚀 Quick Installation in Harbor

1. Launch the **Harbor** app.
2. In the left navigation menu, navigate to **Manga** > click **Set up a source** (or the gear/source icon) > **Extensions**.
3. In the **Repository URL** field, paste the following link and click **Add Repository**:
   ```text
   https://raw.githubusercontent.com/SilverHazer/harbor-manga-sources/main/repo.json
   ```
4. You will see the available extensions appear in the list:
   - **MangaDex (English)** (`mangadex-en` v1.0.0)
   - **Atsu (English)** (`atsu-en` v1.1.0)
   - **Comix.to (English)** (`comix-en` v1.0.0)
5. Click **Install** next to your preferred extensions and select your desired source as the active provider!

---

## 📖 Complete Walkthrough & Architecture

Harbor executes manga extensions inside an isolated JavaScript runtime sandbox. To achieve rock-solid stability and rapid page loading without missing chapters or crashes, each source in this repository implements a specialized architecture:

### 1. MangaDex Provider (`mangadex.plugin.js`)
* **API**: MangaDex REST API v5 (`https://api.mangadex.org`).
* **The Problem**: MangaDex strictly enforces a rate limit of approximately 5 requests per second per IP. When Harbor rapidly queries manga metadata, chapter lists, and page batches, unthrottled requests trigger `HTTP 429 Too Many Requests`, resulting in empty chapter lists or missing pages.
* **Our Solution**:
  - **Request Pacing**: All outgoing API calls are routed through an internal queue with a minimum delay of 260ms between consecutive requests.
  - **Exponential Backoff**: In the rare event of a network error or 429 status, the plugin automatically retries up to 4 times with progressive backoff (`attempt * 1000ms`).
  - **External License Filtering**: MangaDex indexes many chapters hosted on external platforms (such as MangaPlus, Webnovel, or Tapas) that contain zero image files on MangaDex (`pages: 0`). These are automatically excluded using `includeExternalUrl=0` and attribute filtering, ensuring you only receive directly readable chapters.
  - **Direct CDN Image Resolution**: Page images are resolved directly via the official MangaDex@Home endpoint (`/at-home/server/{chapterId}`) to high-speed CDN nodes.

### 2. Atsu.moe Provider (`atsu.plugin.js`)
* **API**: Atsu.moe GraphQL / REST endpoints (`https://atsu.moe/api/v1`).
* **The Problem**: The original implementation enforced an aggressive 8,000ms (8-second) timeout. During peak traffic hours, Atsu.moe experiences response latency spikes, causing premature `FetchError` aborts and broken chapter downloads.
* **Our Solution**:
  - **Increased Timeout Limit**: Extended the request timeout to 30,000ms (30 seconds) using `AbortController`.
  - **3-Stage Retry System**: Automatically retries failed requests up to 3 times with exponential backoff upon network drops or server timeouts.
  - **Safe Concurrency**: Prevents session starvation when retrieving large volumes of page assets concurrently.

### 3. Comix.to Provider (`comix.plugin.js`)
* **API**: Comix.to Mobile/Web API v1 (`https://comix.to/api/v1`).
* **The Problem**: Web scraping Comix.to HTML pages is heavily protected by Cloudflare bot challenges and dynamic token validation.
* **Our Solution**:
  - **Cryptographic Token Signing**: Implements multi-layer S-box cryptographic request signing (`encodeToken`) and envelope response decryption (`decodeEnvelope`) ported from the MIT-licensed Comix connector.
  - **Zero Third-Party Dependencies**: Communicates directly with Comix.to endpoints using Harbor's native `harbor.http` bridge. **No FlareSolverr, Docker, or local proxy is required!**
  - **Blazing Fast**: Loads popular catalogs, search results, full chapter feeds, and high-resolution CDN images in under 1 second.

---

## 🔄 Changelog & Differences vs. Original Repository

This repository is a fork of [`wesazx/harbor-atsu-source`](https://github.com/wesazx/harbor-atsu-source). Below is an overview of the key improvements and architectural additions:

| Component | Original (`wesazx/harbor-atsu-source`) | This Fork (`SilverHazer/harbor-manga-sources`) |
| :--- | :--- | :--- |
| **MangaDex Provider** | Previously removed due to instability and rate-limiting issues (`f2a6109`). | **Completely rebuilt & optimized**: Features a 260ms request-pacing queue, 4-stage exponential backoff against 429 rate limits, automatic filtering of unhosted external links (`pages: 0`), and direct MangaDex@Home CDN image resolution. |
| **Atsu.moe Provider** | Hardcoded 8,000ms timeout with no automatic retries. | **Reinforced network layer**: Timeout increased to 30,000ms, automatic 3-stage retry with exponential backoff on connection drops. |
| **Comix.to Provider** | Not present. | **Brand new source**: Full catalog browsing, instant search, and chapter reading powered by a direct cryptographic signed API (`/api/v1`) with zero proxy dependencies (no FlareSolverr or Docker needed). |
| **Manifest (`repo.json`)** | Contained only `atsu-en`. | Registers all 3 sources (`mangadex-en`, `atsu-en`, `comix-en`) with updated versioning and metadata. |
| **Testing & Tooling** | No automated testing or verification scripts. | Added automated test suite (`npm test`, `npm run check`) to validate plugin contracts and live API endpoints outside of Harbor. |
| **Documentation** | Minimal setup instructions for Atsu only. | Comprehensive documentation, full walkthrough, architecture breakdown, and troubleshooting guide. |

---

## 💡 Alternative / Backup: Suwayomi (Tachidesk) inside Harbor

Did you know that Harbor also provides native, first-class support for **Suwayomi**?
- **Where to find it?** In Harbor under **Manga** > **Set up a source**, you will find an option to connect directly to a Suwayomi Server (default port: `http://localhost:4567`).
- **What is the benefit?** Suwayomi runs locally as a backend server hosting the entire Tachiyomi / Keiyoushi ecosystem (over 1,000+ sources worldwide).
- If any standalone JavaScript scraper ever temporarily breaks due to upstream website redesigns, Suwayomi serves as an unlimited fallback library directly within Harbor.

---

## 🧪 Local Development & Testing

Want to make changes or test a provider locally?

1. Clone this repository:
   ```bash
   git clone https://github.com/SilverHazer/harbor-manga-sources.git
   cd harbor-manga-sources
   ```
2. Run the automated test suite:
   ```bash
   npm test
   ```
3. Validate syntax across all JavaScript plugins:
   ```bash
   npm run check
   ```

---

## 🙏 Credits & Acknowledgements

This project was inspired by and built upon the foundation of:
- **[wesazx](https://github.com/wesazx)** for the original [`harbor-atsu-source`](https://github.com/wesazx/harbor-atsu-source) repository. Thank you for the pioneering work and inspiration to bring external community manga sources to Harbor!
- **[Harbor Stremio](https://github.com/harborstremio/harbor)** for creating an exceptional, modern desktop client for anime, movies, series, and manga.
- The open-source teams behind **[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)** and **[MangaDex](https://mangadex.org)** for their outstanding public APIs and tools.

👥 Contributors & Maintainers
@wesazx – Original creator & Atsu provider
@SilverHazer – MangaDex rewrite, Comix.to signed API provider, and automated test suite
—

## 📄 Disclaimer & License

These extensions are intended exclusively for educational and personal use within the Harbor Stremio reader client. The developers do not host or distribute any media or copyrighted content; all data is fetched on-the-fly directly from respective public web services and APIs. Licensed under the [MIT License](LICENSE).
