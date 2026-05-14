import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as parseHTML } from 'cheerio';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { storage } from '@libs/storage';

class Booktoki implements Plugin.PluginBase {
  id = 'booktoki';
  name = '북토끼 (Booktoki)';
  icon = 'src/kr/booktoki/icon.png';
  site = 'https://sbxh1.com';
  version = '2.0.0';
  static url: string | undefined;
  private static lastRequestTime = 0;
  private static readonly MIN_INTERVAL = 5000;

  private static readonly FS_SESSION_NAME = 'booktoki';
  private static fsSessionReady = false;
  private static fsSessionCreating: Promise<void> | null = null;

  private async throttle() {
    const now = Date.now();
    const elapsed = now - Booktoki.lastRequestTime;
    if (elapsed < Booktoki.MIN_INTERVAL) {
      const jitter = Math.random() * 3000;
      await new Promise(resolve =>
        setTimeout(resolve, Booktoki.MIN_INTERVAL - elapsed + jitter),
      );
    }
    Booktoki.lastRequestTime = Date.now();
  }

  filters = {
    siteUrl: {
      label: '사이트 URL (도메인 변경 시 수정)',
      value: storage.get('booktoki_site_url') || 'https://sbxh1.com',
      type: FilterTypes.TextInput,
    },
    listType: {
      label: '목록 종류',
      value: '0',
      options: [
        { label: '전체', value: '0' },
        { label: '최신 업데이트', value: '1' },
        { label: '완결', value: '2' },
      ],
      type: FilterTypes.Picker,
    },
    flareSolverrUrl: {
      label: 'FlareSolverr URL (끝에 /v1 포함 필수)',
      value: storage.get('booktoki_fs_url') || 'http://localhost:8191/v1',
      type: FilterTypes.TextInput,
    },
    flareSolverrKey: {
      label: 'FlareSolverr API Key (X-API-Key 헤더)',
      value: storage.get('booktoki_fs_key') || '',
      type: FilterTypes.TextInput,
    },
    phpSessId: {
      label: 'Session Cookie (PHPSESSID)',
      value: storage.get('booktoki_phpsessid') || '',
      type: FilterTypes.TextInput,
    },
    bookmarklet: {
      label: '북마크 코드 (전체 복사하여 사용)',
      value:
        "javascript:(function(){const m=document.cookie.match(/PHPSESSID=([^;]+)/);if(m)prompt('PHPSESSID 복사',m[1]);else alert('PHPSESSID를 찾을 수 없습니다. 캡차를 먼저 풀어주세요.');})();",
      type: FilterTypes.TextInput,
    },
  } satisfies Filters;

  private getFlareSolverrSettings(filters?: any) {
    let url = filters?.flareSolverrUrl?.value || '';
    let key = filters?.flareSolverrKey?.value || '';
    let phpSessId = filters?.phpSessId?.value || '';

    if (!url) {
      url = storage.get('booktoki_fs_url') || 'http://localhost:8191/v1';
    } else {
      storage.set('booktoki_fs_url', url);
      this.filters.flareSolverrUrl.value = url;
    }

    if (!key) {
      key = storage.get('booktoki_fs_key') || '';
    } else {
      storage.set('booktoki_fs_key', key);
      this.filters.flareSolverrKey.value = key;
    }

    if (!phpSessId) {
      phpSessId = storage.get('booktoki_phpsessid') || '';
    } else {
      storage.set('booktoki_phpsessid', phpSessId);
      this.filters.phpSessId.value = phpSessId;
    }

    if (url && !url.endsWith('/v1') && !url.endsWith('/v1/')) {
      url = url.replace(/\/$/, '') + '/v1';
    }
    return { url, key, phpSessId };
  }

  private getUserAgent(): string {
    const uas = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    ];
    return uas[Math.floor(Math.random() * uas.length)];
  }

  async checkUrl(filters?: any) {
    const customUrl = (filters?.siteUrl?.value || '').trim().replace(/\/$/, '');
    if (customUrl) {
      if (customUrl !== storage.get('booktoki_site_url')) {
        storage.set('booktoki_site_url', customUrl);
        this.filters.siteUrl.value = customUrl;
        Booktoki.url = customUrl;
      } else if (!Booktoki.url) {
        Booktoki.url = customUrl;
      }
      return;
    }

    if (!Booktoki.url) {
      const savedUrl = storage.get('booktoki_site_url');
      if (savedUrl) {
        Booktoki.url = savedUrl;
        return;
      }
      try {
        const res = await fetchApi(this.site);
        if (res.ok && !res.url.includes('survey-smiles.com')) {
          Booktoki.url = res.url.replace(/\/$/, '');
        } else {
          Booktoki.url = this.site;
        }
      } catch (e) {
        Booktoki.url = this.site;
      }
    }
  }

  private async ensureFsSession(fsUrl: string, key: string): Promise<void> {
    if (Booktoki.fsSessionReady) return;
    if (Booktoki.fsSessionCreating) return Booktoki.fsSessionCreating;

    Booktoki.fsSessionCreating = (async () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (key) headers['X-API-Key'] = key;

      try {
        const res = await fetchApi(fsUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            cmd: 'sessions.create',
            session: Booktoki.FS_SESSION_NAME,
          }),
        });
        const json = JSON.parse(await res.text());
        if (
          json.status === 'ok' ||
          (json.message || '').toLowerCase().includes('already exists')
        ) {
          Booktoki.fsSessionReady = true;
        }
      } catch {
        Booktoki.fsSessionReady = true;
      }
    })().finally(() => {
      Booktoki.fsSessionCreating = null;
    });

    return Booktoki.fsSessionCreating;
  }

  private async fetchViaFlareSolverr(
    url: string,
    filters?: any,
  ): Promise<string> {
    const {
      url: fsUrl,
      key,
      phpSessId,
    } = this.getFlareSolverrSettings(filters);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (key) headers['X-API-Key'] = key;

    await this.ensureFsSession(fsUrl, key);

    const cookies = [];
    if (phpSessId) {
      cookies.push({
        name: 'PHPSESSID',
        value: phpSessId,
        domain: new URL(Booktoki.url || this.site).hostname,
      });
    }

    const payload = JSON.stringify({
      cmd: 'request.get',
      url,
      maxTimeout: 60000,
      session: Booktoki.FS_SESSION_NAME,
      cookies: cookies.length > 0 ? cookies : undefined,
    });
    let lastError: any;

    await this.throttle();

    try {
      const res = await fetchApi(fsUrl, {
        method: 'POST',
        headers,
        body: payload,
      });
      const text = await res.text();
      const json = JSON.parse(text);

      if (
        json.status !== 'ok' &&
        (json.message || '').toLowerCase().includes('session')
      ) {
        Booktoki.fsSessionReady = false;
        await this.ensureFsSession(fsUrl, key);
        const retry = await fetchApi(fsUrl, {
          method: 'POST',
          headers,
          body: payload,
        });
        return this.parseFlareSolverrResponse(await retry.text());
      }

      return this.parseFlareSolverrResponse(text);
    } catch (e: any) {
      lastError = e;
    }

    try {
      const res = await fetch(fsUrl, {
        method: 'POST',
        headers,
        body: payload,
      });
      return this.parseFlareSolverrResponse(await res.text());
    } catch (e: any) {
      throw new Error(
        `FlareSolverr 연결 실패:\n1. fetchApi: ${lastError?.message || lastError}\n2. fetch: ${e?.message || e}\n주소: ${fsUrl}\n(모바일망 사용 시 집 PC와 IP가 달라 FlareSolverr를 반드시 거쳐야 합니다.)`,
      );
    }
  }

  private parseFlareSolverrResponse(body: string): string {
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      throw new Error(`FlareSolverr 응답 비정상: ${body.substring(0, 100)}`);
    }

    if (json.status === 'ok') {
      const cookies = json.solution?.cookies || [];
      const cookieStr = cookies
        .map((c: any) => `${c.name}=${c.value}`)
        .join('; ');

      if (cookieStr) storage.set('booktoki_full_cookies', cookieStr);
      if (json.solution?.userAgent)
        storage.set('booktoki_cached_ua', json.solution.userAgent);

      const response = json.solution?.response || '';

      if (response.includes('403 Forbidden')) {
        storage.delete('booktoki_full_cookies');
        storage.delete('booktoki_cached_ua');
        throw new Error(
          'Cloudflare가 요청을 차단했습니다. 잠시 후 다시 시도하거나 PHPSESSID를 갱신해 주세요.',
        );
      }

      if (this.isCaptcha(response)) {
        throw new Error(
          '숫자 캡차가 발생했습니다. [설정 -> Filter -> 북마크 코드]를 전체 복사하여 브라우저에서 실행한 후, PHPSESSID 값을 가져와 설정에 입력해 주세요.',
        );
      }

      return response;
    }
    throw new Error(json.message || `FlareSolverr 오류 (${json.status})`);
  }

  private getCachedHeaders() {
    const fullCookies = storage.get('booktoki_full_cookies');
    const phpSessId = storage.get('booktoki_phpsessid');
    const ua = storage.get('booktoki_cached_ua') || this.getUserAgent();
    const headers: Record<string, string> = {
      Referer: `${Booktoki.url}/`,
      'User-Agent': ua,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    };
    if (fullCookies) {
      headers['Cookie'] = fullCookies;
      if (phpSessId && !fullCookies.includes('PHPSESSID')) {
        headers['Cookie'] += `; PHPSESSID=${phpSessId}`;
      }
    } else if (phpSessId) {
      headers['Cookie'] = `PHPSESSID=${phpSessId}`;
    }
    return headers;
  }

  private async fetchPage(url: string, filters?: any) {
    const cachedHeaders = this.getCachedHeaders();
    let body = '';
    try {
      const res = await fetchApi(url, { headers: cachedHeaders });
      body = await res.text();
      if (res.ok && !this.isCaptcha(body)) {
        if (
          !body.includes('challenge-platform') &&
          !body.includes('Just a moment...')
        ) {
          return { body };
        }
      }
    } catch (e) {}

    if (body && this.isCaptcha(body)) {
      throw new Error(
        "숫자 캡차가 발생했습니다. 상단 'WebView' 아이콘을 눌러 숫자를 입력하고 돌아와 주세요.",
      );
    }

    return { body: await this.fetchViaFlareSolverr(url, filters) };
  }

  private isCaptcha(body: string): boolean {
    return (
      body.includes('captcha_key') ||
      body.includes('fcaptcha') ||
      body.includes('숫자 입력')
    );
  }

  private parsePath(href: string): string {
    if (href.startsWith('http')) {
      try {
        return new URL(href).pathname.replace(/^\//, '');
      } catch {
        return href;
      }
    }
    return href.replace(/^\//, '');
  }

  private parseNovelCards(body: string): Plugin.NovelItem[] {
    const $ = parseHTML(body);
    const novels: Plugin.NovelItem[] = [];
    $('div.card-grid a.card').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (!href.includes('/novel/')) return;
      const name = $(el).find('p.subject').text().trim();
      const cover = $(el).find('.thumb img:not(.platform-icon)').attr('src');
      if (name && href) {
        novels.push({
          name,
          cover,
          path: this.parsePath(href),
        });
      }
    });
    return novels;
  }

  async popularNovels(
    pageNo: number,
    { showLatestNovels, filters }: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    await this.checkUrl(filters);
    const listType = (filters as any)?.listType?.value ?? '0';
    let url: string;
    if (listType === '2') {
      url = `${Booktoki.url}/novel-end?page=${pageNo}`;
    } else if (listType === '1' || showLatestNovels) {
      url = `${Booktoki.url}/novel/updates?page=${pageNo}`;
    } else {
      url = `${Booktoki.url}/novel?page=${pageNo}`;
    }
    const { body } = await this.fetchPage(url, filters);
    return this.parseNovelCards(body);
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    await this.checkUrl(undefined);
    const url = `${Booktoki.url}/search?q=${encodeURIComponent(searchTerm)}&kind=novel&page=${pageNo}`;
    const { body } = await this.fetchPage(url);
    return this.parseNovelCards(body);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    await this.checkUrl(undefined);
    const url = `${Booktoki.url}/${novelPath}`;
    const { body } = await this.fetchPage(url);
    const $ = parseHTML(body);

    const novelName =
      $('h1.hero-v2-title').text().trim() ||
      $('div.nd-info > h1').text().trim();

    const cover =
      $('div.hero-v2-thumb img:not(.platform-icon)').attr('src') ||
      $('div.nd-thumb img').attr('src');

    const summary = $('p.hero-v2-desc').text().trim();

    const author =
      $('div.hero-v2-author a').first().text().trim() ||
      $('div.hero-v2-author').text().trim() ||
      $('div.nd-meta span').first().text().trim();

    const genre = $('a.hero-v2-tag')
      .map((i, el) => $(el).text().trim().replace(/^#/, ''))
      .get()
      .join(', ');

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: novelName,
      cover,
      summary,
      author,
      genres: genre,
      chapters: [],
    };

    const seenPaths = new Set<string>();

    // ep-list-v2 format (sbxh1.com primary)
    let chapterEls = $('ul.ep-list-v2 li.ep-row-v2').not('.ep-row-v2--failed');
    const useEpFormat = chapterEls.length > 0;

    // novel-eps format (blacktoon fallback)
    if (!useEpFormat) {
      chapterEls = $('ul.novel-eps li');
    }

    chapterEls.each((i, el) => {
      let chapterUrl = '';
      let chapterNum = 0;
      let chapterName = '';
      let releaseTime = '';

      if (useEpFormat) {
        chapterUrl = $(el).find('a.ep-row-v2-link').attr('href') || '';
        chapterNum =
          parseInt($(el).find('span.ep-row-v2-no').text().trim()) || 0;
        chapterName = $(el).find('.ep-row-v2-title strong').text().trim();
        releaseTime = $(el)
          .find('span.ep-row-v2-date')
          .text()
          .trim()
          .replace(/\./g, '-');
      } else {
        chapterUrl = $(el).find('a').attr('href') || '';
        chapterNum = parseInt($(el).find('span.ne-num').text().trim()) || 0;
        chapterName = $(el).find('span.ne-title').text().trim();
        releaseTime = $(el)
          .find('span.ne-date')
          .text()
          .trim()
          .replace(/\./g, '-');
      }

      if (!chapterUrl || seenPaths.has(chapterUrl)) return;
      seenPaths.add(chapterUrl);

      if (!chapterName) chapterName = chapterNum ? `${chapterNum}화` : '';

      novel.chapters?.push({
        name: chapterName,
        path: this.parsePath(chapterUrl),
        releaseTime,
        chapterNumber: chapterNum,
      });
    });

    novel.chapters?.sort(
      (a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0),
    );
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    await this.checkUrl(undefined);
    const { body } = await this.fetchPage(`${Booktoki.url}/${chapterPath}`);
    const $ = parseHTML(body);

    // sbxh1.com novel viewer
    let content = $('article.novel-viewer').html() || '';

    // Fallback: old html_data JS encoding (booktoki legacy)
    if (!content) {
      let combined = '';
      $('script').each((i, s) => {
        const sc = $(s).html() || '';
        if (sc.includes('var html_data')) {
          const regex = /html_data\+='(.*?)';/g;
          let match;
          while ((match = regex.exec(sc)) !== null) combined += match[1];
        }
      });
      if (combined) content = this.decodeHtmlData(combined);
    }

    // Fallback: static content divs
    if (!content) {
      content = $('#novel_content').html() || $('.view-content').html() || '';
    }

    if (content) {
      const $c = parseHTML(content);
      $c(
        'script, style, iframe, ins, [style*="display:none"], [style*="font-size:0"]',
      ).remove();
      content = $c.html();
    }
    return content || '본문을 불러올 수 없습니다.';
  }

  private decodeHtmlData(encoded: string): string {
    let result = '';
    for (let i = 0; i < encoded.length; i += 3) {
      result += String.fromCharCode(parseInt(encoded.substring(i, i + 2), 16));
    }
    return result;
  }

  resolveUrl(path: string) {
    return (Booktoki.url || this.site) + '/' + path;
  }
}

export default new Booktoki();
