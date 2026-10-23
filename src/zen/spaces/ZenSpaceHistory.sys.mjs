/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Keeps a history for each space.
 *
 * With `zen.workspaces.separate-history` set, every page a tab visits is also
 * written down for the space that tab belongs to, and the library lists the
 * history of the space being looked at instead of the global one. Places
 * keeps recording as before, so the address bar still suggests from all of
 * the history.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

const PREF = "zen.workspaces.separate-history";
const DB_FILENAME = "zen-space-history.sqlite";
const SCHEMA_VERSION = 1;
const CHANGED_TOPIC = "zen-space-history-changed";

class nsZenSpaceHistory {
  #initialized = false;
  #connectionPromise = null;
  #windows = new WeakSet();
  #notifyPending = false;
  #placesListener = null;

  get enabled() {
    return Services.prefs.getBoolPref(PREF, false);
  }

  #init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
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
    const progressListener = {
      onLocationChange: (browser, webProgress, request, location, flags) =>
        this.#onLocationChange(browser, webProgress, location, flags),
    };
    const onTitleChanged = event =>
      this.#onTitleChanged(window.gBrowser.getTabForBrowser(event.target));
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
    if (topic === "nsPref:changed") {
      this.#notifyChanged();
    }
  }

  #onPlacesEvents(events) {
    // Clearing all of the history also clears the history of every space.
    if (events.some(event => event.type === "history-cleared")) {
      this.#clearIfStored().catch(console.error);
    }
  }

  async #clearIfStored() {
    // Don't make the store only to empty it.
    if (
      !this.#connectionPromise &&
      !(await IOUtils.exists(PathUtils.join(PathUtils.profileDir, DB_FILENAME)))
    ) {
      return;
    }
    await this.clear();
  }

  /**
   * @param {MozTabbrowserTab} tab
   * @returns {string?} The space a tab's visits are written down for. An
   *   essential tab is shared by every space, so it counts for the one it
   *   is used in.
   */
  #spaceOf(tab) {
    if (!tab || !this.enabled) {
      return null;
    }
    const window = tab.ownerGlobal;
    if (!tab.hasAttribute("zen-essential")) {
      const spaceId = tab.getAttribute("zen-workspace-id");
      if (spaceId) {
        return spaceId;
      }
    }
    return window.gZenWorkspaces?.activeWorkspace || null;
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
    const tab = browser.ownerGlobal.gBrowser?.getTabForBrowser(browser);
    const spaceId = this.#spaceOf(tab);
    if (!spaceId || !this.#canAddURI(location)) {
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
      spaceId,
    }).catch(console.error);
  }

  #onTitleChanged(tab) {
    const spaceId = this.#spaceOf(tab);
    const browser = tab.linkedBrowser;
    const location = browser?.currentURI;
    const title = browser?.contentTitle;
    if (!spaceId || !title || !location || !this.#canAddURI(location)) {
      return;
    }
    this.#setTitle({ url: location.spec, title, spaceId }).catch(console.error);
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
              space_id TEXT NOT NULL,
              visit_date INTEGER NOT NULL
            )
          `);
          await connection.execute(`
            CREATE INDEX IF NOT EXISTS visits_space_date
            ON visits (space_id, visit_date)
          `);
          await connection.execute(`
            CREATE INDEX IF NOT EXISTS visits_space_url
            ON visits (space_id, url)
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

  async #addVisit({ url, title, spaceId }) {
    const connection = await this.#getConnection();
    await connection.execute(
      // A page visited again keeps the title it was last known by until
      // its own comes.
      `INSERT INTO visits (url, title, space_id, visit_date)
       VALUES (:url, COALESCE(NULLIF(:title, ''), (
         SELECT title FROM visits
         WHERE space_id = :spaceId AND url = :url
         ORDER BY visit_date DESC LIMIT 1
       ), ''), :spaceId, :date)`,
      { url, title, spaceId, date: Date.now() }
    );
    this.#notifyChanged();
  }

  async #setTitle({ url, title, spaceId }) {
    const connection = await this.#getConnection();
    await connection.execute(
      `UPDATE visits SET title = :title
       WHERE id = (
         SELECT id FROM visits
         WHERE space_id = :spaceId AND url = :url
         ORDER BY visit_date DESC LIMIT 1
       ) AND title != :title`,
      { url, title, spaceId }
    );
    this.#notifyChanged();
  }

  /**
   * The visits made in a space, newest first, in the shape the library lists
   * history in.
   *
   * @param {object} options
   * @param {string} options.spaceId - The space
   * @param {number} [options.limit] - How many visits to give at most
   * @param {Date} [options.beginDate] - Leave out visits older than this
   * @param {string} [options.search] - Only visits whose title or url has it
   * @param {boolean} [options.mostVisited] - One row per page, the most
   *   visited first
   * @returns {Promise<object[]>}
   */
  async getVisits({
    spaceId,
    limit = 100,
    beginDate = null,
    search = "",
    mostVisited = false,
  }) {
    const connection = await this.#getConnection();
    const params = {
      spaceId,
      limit,
      begin: beginDate ? beginDate.getTime() : 0,
    };
    let where = "space_id = :spaceId AND visit_date >= :begin";
    if (search) {
      where += ` AND (url LIKE :search ESCAPE '/' OR title LIKE :search ESCAPE '/')`;
      params.search = `%${connection.escapeStringForLIKE(search, "/")}%`;
    }
    const rows = mostVisited
      ? await connection.execute(
          `SELECT MAX(id) AS id, url, MAX(visit_date) AS visit_date,
                  (SELECT title FROM visits AS latest
                   WHERE latest.space_id = :spaceId AND latest.url = visits.url
                   ORDER BY latest.visit_date DESC LIMIT 1) AS title,
                  COUNT(*) AS visit_count
           FROM visits WHERE ${where}
           GROUP BY url
           ORDER BY visit_count DESC, visit_date DESC
           LIMIT :limit`,
          params
        )
      : await connection.execute(
          `SELECT id, url, title, visit_date FROM visits
           WHERE ${where}
           ORDER BY visit_date DESC
           LIMIT :limit`,
          params
        );
    return rows.map(row => ({
      url: row.getResultByName("url"),
      title: row.getResultByName("title"),
      date: new Date(row.getResultByName("visit_date")),
      guid: `space-${row.getResultByName("id")}`,
      spaceId,
    }));
  }

  /**
   * Forgets every visit made to a page in a space.
   *
   * @param {string} url
   * @param {string} spaceId
   */
  async removeUrl(url, spaceId) {
    const connection = await this.#getConnection();
    await connection.execute(
      `DELETE FROM visits WHERE space_id = :spaceId AND url = :url`,
      { url, spaceId }
    );
    this.#notifyChanged();
  }

  /**
   * Forgets visits, of one space or of all of them, made since a date or
   * ever.
   *
   * @param {object} [options]
   * @param {string} [options.spaceId] - Only this space's visits
   * @param {Date} [options.beginDate] - Only visits made since then
   */
  async clear({ spaceId = null, beginDate = null } = {}) {
    const connection = await this.#getConnection();
    const conditions = [];
    const params = {};
    if (spaceId !== null) {
      conditions.push("space_id = :spaceId");
      params.spaceId = spaceId;
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

export const ZenSpaceHistory = new nsZenSpaceHistory();
