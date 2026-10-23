/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Keeps the history of every container apart.
 *
 * With `zen.containers.separate-history` set, a tab that lives in a container
 * never writes to the Places history: its browser is told not to use global
 * history, and its visits are written down in a history of that container's
 * own. The global history is then only what was browsed outside containers.
 *
 * The views of history ask `createPlacesQuery()` for what to read from: in a
 * container whose history is kept apart, it gives an object that answers the
 * way a `PlacesQuery` does, from that container's history. The Zen library
 * and Firefox View (and so about:history) read through it.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

const PREF = "zen.containers.separate-history";
const DB_FILENAME = "zen-container-history.sqlite";
const SCHEMA_VERSION = 1;
const CHANGED_TOPIC = "zen-container-history-changed";
const BROWSER_INSERTED_TOPIC = "tabbrowser-browser-element-will-be-inserted";
const CONTAINER_DELETED_TOPIC = "contextual-identity-deleted";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

class nsZenContainerHistory {
  #initialized = false;
  #connectionPromise = null;
  #windows = new WeakSet();
  #notifyPending = false;
  #placesListener = null;

  get enabled() {
    return Services.prefs.getBoolPref(PREF, false);
  }

  /**
   * Whether the visits of a container are kept apart from the global history.
   *
   * @param {number} userContextId
   * @returns {boolean}
   */
  isSeparate(userContextId) {
    return this.enabled && !!userContextId;
  }

  /**
   * @param {Window} window - A window showing history, such as Firefox View
   *   in a tab, or a browser window
   * @returns {number} The container it was opened in, 0 when none
   */
  userContextIdOf(window) {
    if (window?.gBrowser) {
      return window.gBrowser.selectedTab?.userContextId || 0;
    }
    return window?.browsingContext?.originAttributes?.userContextId || 0;
  }

  /**
   * What history should be read from for a container.
   *
   * @param {number} userContextId
   * @returns {ZenContainerPlacesQuery?} A query over the container's own
   *   history when it is kept apart, or null to read the global history
   */
  createPlacesQuery(userContextId) {
    if (!this.isSeparate(userContextId)) {
      return null;
    }
    this.#init();
    return new ZenContainerPlacesQuery(this, userContextId);
  }

  #init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    Services.obs.addObserver(this, BROWSER_INSERTED_TOPIC);
    Services.obs.addObserver(this, CONTAINER_DELETED_TOPIC);
    Services.prefs.addObserver(PREF, this);
    this.#placesListener = this.#onPlacesEvents.bind(this);
    lazy.PlacesUtils.observers.addListener(
      ["history-cleared"],
      this.#placesListener
    );
  }

  uninit() {
    if (!this.#initialized) {
      return;
    }
    this.#initialized = false;
    Services.obs.removeObserver(this, BROWSER_INSERTED_TOPIC);
    Services.obs.removeObserver(this, CONTAINER_DELETED_TOPIC);
    Services.prefs.removeObserver(PREF, this);
    lazy.PlacesUtils.observers.removeListener(
      ["history-cleared"],
      this.#placesListener
    );
    this.#connectionPromise
      ?.then(connection => connection.close())
      .catch(console.error);
    this.#connectionPromise = null;
  }

  /**
   * Auto invoked for every window on delayed startup
   *
   * @param {nsIDOMWindow} window - The browser window that just started up
   */
  onDelayedBrowserStartup(window) {
    this.#init();
    if (
      this.#windows.has(window) ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(window)
    ) {
      return;
    }
    this.#windows.add(window);
    // Tabs restored or opened before this point were inserted before we
    // started observing them.
    for (const browser of window.gBrowser.browsers) {
      this.#applyToBrowser(browser);
    }
    const progressListener = {
      onLocationChange: (browser, webProgress, request, location, flags) =>
        this.#onLocationChange(browser, webProgress, location, flags),
    };
    const onTitleChanged = event => this.#onTitleChanged(event.target);
    window.gBrowser.addTabsProgressListener(progressListener);
    window.gBrowser.addEventListener("pagetitlechanged", onTitleChanged);
    window.addEventListener(
      "unload",
      () => {
        window.gBrowser.removeTabsProgressListener(progressListener);
        window.gBrowser.removeEventListener("pagetitlechanged", onTitleChanged);
      },
      { once: true }
    );
  }

  observe(subject, topic) {
    switch (topic) {
      case BROWSER_INSERTED_TOPIC:
        this.#applyToBrowser(subject);
        break;
      case "nsPref:changed":
        for (const window of lazy.BrowserWindowTracker.orderedWindows) {
          for (const browser of window.gBrowser?.browsers ?? []) {
            this.#applyToBrowser(browser);
          }
        }
        this.#notifyChanged();
        break;
      case CONTAINER_DELETED_TOPIC: {
        const userContextId = subject?.wrappedJSObject?.userContextId;
        if (userContextId) {
          this.#clearIfStored({ userContextId }).catch(console.error);
        }
        break;
      }
    }
  }

  #onPlacesEvents(events) {
    // Clearing all of the history also clears what containers kept apart.
    if (events.some(event => event.type === "history-cleared")) {
      this.#clearIfStored().catch(console.error);
    }
  }

  async #clearIfStored(options) {
    // Don't make the store only to empty it.
    if (
      !this.#connectionPromise &&
      !(await IOUtils.exists(PathUtils.join(PathUtils.profileDir, DB_FILENAME)))
    ) {
      return;
    }
    await this.clear(options);
  }

  /**
   * Keeps a container tab's browser out of the global history, or lets it
   * back in once its history is no longer kept apart.
   *
   * @param {MozBrowser} browser
   */
  #applyToBrowser(browser) {
    if (!browser || browser.getAttribute("type") !== "content") {
      return;
    }
    const userContextId = parseInt(
      browser.getAttribute("usercontextid") || "0",
      10
    );
    const separate = this.isSeparate(userContextId);
    if (separate) {
      // Read by gecko when the browsing context gets its embedder, which
      // also covers browsers that get a new browsing context later on.
      browser.setAttribute("disableglobalhistory", "true");
    } else if (browser.hasAttribute("disableglobalhistory")) {
      browser.removeAttribute("disableglobalhistory");
    } else {
      return;
    }
    const browsingContext = browser.browsingContext;
    if (browsingContext && browsingContext.useGlobalHistory === separate) {
      try {
        browsingContext.useGlobalHistory = !separate;
      } catch (e) {
        console.error("ZenContainerHistory: Could not set global history", e);
      }
    }
  }

  /**
   * @param {MozBrowser} browser
   * @returns {number?} The container of a browser whose visits are kept
   *   apart, if they are
   */
  #separateContextOf(browser) {
    const userContextId = parseInt(
      browser?.getAttribute("usercontextid") || "0",
      10
    );
    if (
      !this.isSeparate(userContextId) ||
      lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)
    ) {
      return null;
    }
    return userContextId;
  }

  #onLocationChange(browser, webProgress, location, flags) {
    if (!webProgress?.isTopLevel || !location) {
      return;
    }
    if (
      flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE ||
      flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_RELOAD
    ) {
      return;
    }
    const userContextId = this.#separateContextOf(browser);
    if (userContextId === null || !this.#canAddURI(location)) {
      return;
    }
    this.#addVisit({
      url: location.spec,
      // A new document has no title yet, and the browser still holds the
      // last one's; it comes with pagetitlechanged.
      title:
        flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
          ? browser.contentTitle || ""
          : "",
      userContextId,
    }).catch(console.error);
  }

  #onTitleChanged(browser) {
    const userContextId = this.#separateContextOf(browser);
    const location = browser?.currentURI;
    const title = browser?.contentTitle;
    if (
      userContextId === null ||
      !title ||
      !location ||
      !this.#canAddURI(location)
    ) {
      return;
    }
    this.#setTitle({ url: location.spec, title, userContextId }).catch(
      console.error
    );
  }

  #canAddURI(uri) {
    try {
      return lazy.PlacesUtils.history.canAddURI(uri);
    } catch {
      return false;
    }
  }

  #getConnection() {
    if (!this.#connectionPromise) {
      this.#connectionPromise = this.#openConnection();
      this.#connectionPromise.catch(() => {
        this.#connectionPromise = null;
      });
    }
    return this.#connectionPromise;
  }

  async #openConnection() {
    const connection = await lazy.Sqlite.openConnection({
      path: PathUtils.join(PathUtils.profileDir, DB_FILENAME),
    });
    try {
      const version = await connection.getSchemaVersion();
      if (version < SCHEMA_VERSION) {
        await connection.executeTransaction(async () => {
          await connection.execute(`
            CREATE TABLE IF NOT EXISTS visits (
              id INTEGER PRIMARY KEY,
              url TEXT NOT NULL,
              title TEXT NOT NULL DEFAULT '',
              user_context_id INTEGER NOT NULL,
              visit_date INTEGER NOT NULL
            )
          `);
          await connection.execute(`
            CREATE INDEX IF NOT EXISTS visits_context_date
            ON visits (user_context_id, visit_date)
          `);
          await connection.execute(`
            CREATE INDEX IF NOT EXISTS visits_context_url
            ON visits (user_context_id, url)
          `);
          await connection.setSchemaVersion(SCHEMA_VERSION);
        });
      }
    } catch (e) {
      await connection.close();
      throw e;
    }
    return connection;
  }

  #notifyChanged() {
    // Visits and titles tend to come in a row; tell observers once.
    if (this.#notifyPending) {
      return;
    }
    this.#notifyPending = true;
    Services.tm.dispatchToMainThread(() => {
      this.#notifyPending = false;
      Services.obs.notifyObservers(null, CHANGED_TOPIC);
    });
  }

  async #addVisit({ url, title, userContextId }) {
    const connection = await this.#getConnection();
    await connection.execute(
      // A page visited again keeps the title it was last known by until
      // its own comes.
      `INSERT INTO visits (url, title, user_context_id, visit_date)
       VALUES (:url, COALESCE(NULLIF(:title, ''), (
         SELECT title FROM visits
         WHERE user_context_id = :userContextId AND url = :url
         ORDER BY visit_date DESC LIMIT 1
       ), ''), :userContextId, :date)`,
      { url, title, userContextId, date: Date.now() }
    );
    this.#notifyChanged();
  }

  async #setTitle({ url, title, userContextId }) {
    const connection = await this.#getConnection();
    await connection.execute(
      `UPDATE visits SET title = :title
       WHERE id = (
         SELECT id FROM visits
         WHERE user_context_id = :userContextId AND url = :url
         ORDER BY visit_date DESC LIMIT 1
       ) AND title != :title`,
      { url, title, userContextId }
    );
    this.#notifyChanged();
  }

  /**
   * The pages a container visited, newest first, one row per page, or per
   * page and day when `perDay` is set, in the shape `PlacesQuery` gives
   * visits in.
   *
   * @param {object} options
   * @param {number} options.userContextId - The container
   * @param {number} [options.limit] - How many rows to give at most
   * @param {Date} [options.beginDate] - Leave out visits older than this
   * @param {string} [options.search] - Only pages whose title or url has it
   * @param {boolean} [options.perDay] - One row per page and day
   * @param {boolean} [options.mostVisited] - The most visited first
   * @returns {Promise<object[]>}
   */
  async getVisits({
    userContextId,
    limit = -1,
    beginDate = null,
    search = "",
    perDay = false,
    mostVisited = false,
  }) {
    const connection = await this.#getConnection();
    const params = {
      userContextId,
      limit: limit > 0 ? limit : -1,
      begin: beginDate ? beginDate.getTime() : 0,
    };
    let where = "user_context_id = :userContextId AND visit_date >= :begin";
    if (search) {
      where += ` AND (url LIKE :search ESCAPE '/' OR title LIKE :search ESCAPE '/')`;
      params.search = `%${connection.escapeStringForLIKE(search, "/")}%`;
    }
    const groupBy = perDay
      ? "url, date(visit_date / 1000, 'unixepoch', 'localtime')"
      : "url";
    const orderBy = mostVisited
      ? "visit_count DESC, visit_date DESC"
      : "visit_date DESC";
    // SQLite takes the bare columns from the row holding MAX(visit_date), so
    // a page is named by its latest title.
    const rows = await connection.execute(
      `SELECT url, title, MAX(visit_date) AS visit_date,
              COUNT(*) AS visit_count
       FROM visits WHERE ${where}
       GROUP BY ${groupBy}
       ORDER BY ${orderBy}
       LIMIT :limit`,
      params
    );
    return rows.map(row => ({
      date: new Date(row.getResultByName("visit_date")),
      title: row.getResultByName("title"),
      url: row.getResultByName("url"),
      visitCount: row.getResultByName("visit_count"),
      // Stands in for the page guid Places would give.
      guid: `container-${userContextId}-${row.getResultByName("url")}`,
      userContextId,
    }));
  }

  /**
   * Forgets every visit a container made to a page.
   *
   * @param {string} url
   * @param {number} userContextId
   */
  async removeUrl(url, userContextId) {
    const connection = await this.#getConnection();
    await connection.execute(
      `DELETE FROM visits WHERE user_context_id = :userContextId AND url = :url`,
      { url, userContextId }
    );
    this.#notifyChanged();
  }

  /**
   * Forgets visits, of one container or of all of them, made since a date or
   * ever.
   *
   * @param {object} [options]
   * @param {number} [options.userContextId] - Only this container's visits
   * @param {Date} [options.beginDate] - Only visits made since then
   */
  async clear({ userContextId = null, beginDate = null } = {}) {
    const connection = await this.#getConnection();
    const conditions = [];
    const params = {};
    if (userContextId !== null) {
      conditions.push("user_context_id = :userContextId");
      params.userContextId = userContextId;
    }
    if (beginDate) {
      conditions.push("visit_date >= :begin");
      params.begin = beginDate.getTime();
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    await connection.execute(`DELETE FROM visits ${where}`, params);
    this.#notifyChanged();
  }
}

/**
 * Answers the way a `PlacesQuery` does (see PlacesQuery.sys.mjs), from the
 * history of one container instead of the global one, so that what reads
 * history through a `PlacesQuery` can read a container's history as well.
 */
class ZenContainerPlacesQuery {
  #history;
  #cache = null;
  #callback = null;
  #closed = false;
  cachedHistoryOptions = null;

  /**
   * @param {nsZenContainerHistory} history
   * @param {number} userContextId - The container to read the history of
   */
  constructor(history, userContextId) {
    this.#history = history;
    this.userContextId = userContextId;
    Services.obs.addObserver(this, CHANGED_TOPIC);
  }

  get cachedHistory() {
    return this.#cache;
  }

  observe() {
    if (this.#closed || !this.cachedHistoryOptions) {
      return;
    }
    this.#cache = null;
    this.getHistory(this.cachedHistoryOptions)
      .then(history => this.#callback?.(history))
      .catch(console.error);
  }

  /**
   * @param {object} [options] - As `PlacesQuery.getHistory` takes them
   * @returns {Promise<Map|object[]>} The visits, grouped as `PlacesQuery`
   *   groups them for the same sort
   */
  async getHistory({ daysOld = 60, limit, sortBy = "date" } = {}) {
    const options = { daysOld, limit, sortBy };
    const sameOptions =
      this.cachedHistoryOptions &&
      Object.entries(options).every(
        ([key, value]) => this.cachedHistoryOptions[key] === value
      );
    if (this.#cache && sameOptions) {
      return this.#cache;
    }
    this.cachedHistoryOptions = options;
    const visits = await this.#history.getVisits({
      userContextId: this.userContextId,
      limit,
      beginDate: this.#beginDate(daysOld),
      perDay: sortBy === "date" || sortBy === "datesite",
      mostVisited: sortBy === "mostvisited",
    });
    if (this.#closed) {
      return null;
    }
    this.#cache = this.#group(visits, sortBy);
    return this.#cache;
  }

  /**
   * @param {string} query
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async searchHistory(query, limit) {
    const sortBy = this.cachedHistoryOptions?.sortBy;
    const visits = await this.#history.getVisits({
      userContextId: this.userContextId,
      limit,
      search: query,
      mostVisited: sortBy === "mostvisited",
    });
    if (sortBy === "site") {
      visits.sort((a, b) => a.url.localeCompare(b.url));
    }
    return visits;
  }

  observeHistory(callback) {
    this.#callback = callback;
  }

  close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#cache = null;
    this.#callback = null;
    this.cachedHistoryOptions = null;
    Services.obs.removeObserver(this, CHANGED_TOPIC);
  }

  /**
   * Forgets a page from the container's history.
   *
   * @param {string} url
   * @returns {Promise}
   */
  removeUrl(url) {
    return this.#history.removeUrl(url, this.userContextId);
  }

  getStartOfDayTimestamp(date) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate()
    ).getTime();
  }

  getStartOfMonthTimestamp(date) {
    return new Date(date.getFullYear(), date.getMonth()).getTime();
  }

  #beginDate(daysOld) {
    if (daysOld == Infinity) {
      return null;
    }
    const startOfToday = this.getStartOfDayTimestamp(new Date());
    return new Date(startOfToday - Number(daysOld) * MS_PER_DAY);
  }

  #siteOf(url) {
    const protocol = URL.parse(url)?.protocol;
    return protocol == "http:" || protocol == "https:"
      ? lazy.BrowserUtils.formatURIStringForDisplay(url)
      : "";
  }

  #group(visits, sortBy) {
    if (sortBy === "lastvisited" || sortBy === "mostvisited") {
      return visits;
    }
    const groups = new Map();
    const listIn = (map, key) => {
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      return list;
    };
    for (const visit of visits) {
      if (sortBy === "site") {
        listIn(groups, this.#siteOf(visit.url)).push(visit);
        continue;
      }
      const day = this.getStartOfDayTimestamp(visit.date);
      if (sortBy === "datesite") {
        if (!groups.has(day)) {
          groups.set(day, new Map());
        }
        listIn(groups.get(day), this.#siteOf(visit.url)).push(visit);
        continue;
      }
      listIn(groups, day).push(visit);
    }
    return groups;
  }
}

export const ZenContainerHistory = new nsZenContainerHistory();
