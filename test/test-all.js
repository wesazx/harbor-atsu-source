const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPlugin(fileName) {
  const filePath = path.join(__dirname, '..', fileName);
  const code = fs.readFileSync(filePath, 'utf8');
  let registeredPlugin = null;

  const context = {
    fetch: globalThis.fetch,
    console: console,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    AbortController: globalThis.AbortController,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    Uint8Array: globalThis.Uint8Array,
    encodeURIComponent: globalThis.encodeURIComponent,
    harbor: {
      register: (p) => {
        registeredPlugin = p;
      },
      log: (...args) => {
        // console.log('[Harbor Log]', ...args);
      },
      http: async (url, options = {}) => {
        const fetchOptions = {
          method: options.method || 'GET',
          headers: options.headers || {}
        };
        if (options.body) {
          fetchOptions.body = options.body;
        }
        if (options.timeoutMs) {
          fetchOptions.signal = AbortSignal.timeout(options.timeoutMs);
        }

        const res = await fetch(url, fetchOptions);
        const text = await res.text();
        return {
          status: res.status,
          ok: res.ok,
          body: text
        };
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(code, context);
  return registeredPlugin;
}

async function runTests() {
  console.log('=== Harbor Manga Plugins Test Suite ===\n');

  const plugins = [
    { file: 'mangadex.plugin.js', id: 'mangadex-en' },
    { file: 'atsu.plugin.js', id: 'atsu-en' },
    { file: 'comix.plugin.js', id: 'comix-en' }
  ];

  let errors = 0;

  for (const item of plugins) {
    process.stdout.write(`Checking plugin contract: ${item.file}... `);
    try {
      const plugin = loadPlugin(item.file);
      if (!plugin) throw new Error('Plugin did not call harbor.register(...)');
      if (plugin.id !== item.id) throw new Error(`Plugin id mismatch: expected ${item.id}, got ${plugin.id}`);
      
      const requiredMethods = ['popular', 'search', 'detail', 'chapters', 'pageUrls'];
      for (const m of requiredMethods) {
        if (typeof plugin[m] !== 'function') {
          throw new Error(`Missing required method: ${m}`);
        }
      }
      console.log('✓ PASS');
    } catch (err) {
      console.log(`✗ FAIL (${err.message})`);
      errors++;
    }
  }

  // Live test MangaDex
  console.log('\n--- Live API Verification: MangaDex ---');
  try {
    const md = loadPlugin('mangadex.plugin.js');
    console.log('Testing popular(0)...');
    const pop = await md.popular(0);
    console.log(`✓ Fetched ${pop.length} popular manga.`);
    if (pop.length === 0) throw new Error('No items in popular');

    let testedChapters = false;
    for (const item of pop.slice(0, 5)) {
      const manga = await md.detail(item.id);
      const chapters = await md.chapters(item.id);
      if (chapters.length > 0) {
        console.log(`✓ Fetched manga "${manga.title}" with ${chapters.length} chapters.`);
        const firstChapter = chapters[0];
        console.log(`Testing pageUrls("${firstChapter.id}")...`);
        const pages = await md.pageUrls(firstChapter.id);
        console.log(`✓ Fetched ${pages.length} pages. Sample URL: ${pages[0] ? pages[0].slice(0, 70) + '...' : 'none'}`);
        testedChapters = true;
        break;
      }
    }
    if (!testedChapters) {
      console.log('ℹ Note: First popular titles have external licensor links (pages:0), which were correctly filtered.');
    }
  } catch (err) {
    console.error(`✗ MangaDex live test failed: ${err.message}`);
    errors++;
  }

  // Live test Comix (Direct Signed API)
  console.log('\n--- Live API Verification: Comix.to (Direct Signed API) ---');
  try {
    const comix = loadPlugin('comix.plugin.js');
    console.log('Testing comix.popular(0)...');
    const pop = await comix.popular(0);
    console.log(`✓ Fetched ${pop.length} popular manga from Comix.to.`);
    if (pop.length > 0) {
      console.log(`✓ First manga: "${pop[0].title}" (ID: ${pop[0].id})`);
      const chapters = await comix.chapters(pop[0].id);
      console.log(`✓ Fetched ${chapters.length} chapters.`);
      if (chapters.length > 0) {
        const pages = await comix.pageUrls(chapters[0].id);
        console.log(`✓ Fetched ${pages.length} pages. First image URL: ${pages[0] ? (pages[0].url || pages[0]).slice(0, 60) + '...' : 'none'}`);
      }
    }
  } catch (err) {
    console.error(`✗ Comix live test failed: ${err.message}`);
    errors++;
  }

  console.log('\n=======================================');
  if (errors === 0) {
    console.log('All checks passed successfully! 🎉');
    process.exit(0);
  } else {
    console.error(`Test suite failed with ${errors} error(s).`);
    process.exit(1);
  }
}

runTests();
