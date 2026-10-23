/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenContainerHistory } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenContainerHistory.sys.mjs"
);
const { ZenSpaceHistory } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSpaceHistory.sys.mjs"
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

const PAGE_TITLE = "Zen history test page";

/**
 * @param {string} query - Makes the url unique to the test
 * @returns {string} The url of the test page, which has a title
 */
function pageURL(query) {
  return (
    getRootDirectory(gTestPath).replace(
      "chrome://mochitests/content/",
      "https://example.com/"
    ) + `file_title.html?${query}`
  );
}

/**
 * Opens a tab in a container, selects it and waits for it to load.
 *
 * @param {string} url
 * @param {number} userContextId - 0 for no container
 * @returns {Promise<MozTabbrowserTab>}
 */
async function openTabIn(url, userContextId) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, {
    skipAnimation: true,
    userContextId,
  });
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  return tab;
}

/**
 * @param {number} userContextId
 * @param {string} url
 * @returns {Promise<object>} The container's visit to the page, once it has
 *   its title
 */
async function waitForContainerVisit(userContextId, url) {
  let visit;
  await TestUtils.waitForCondition(async () => {
    const visits = await ZenContainerHistory.getVisits({ userContextId });
    visit = visits.find(v => v.url === url && v.title === PAGE_TITLE);
    return visit;
  }, `container ${userContextId} recorded ${url} with its title`);
  return visit;
}

async function cleanUpHistory() {
  await ZenContainerHistory.clear();
  await ZenSpaceHistory.clear();
  await PlacesUtils.history.clear();
}

/**
 * Opens the library on its history tab and waits for a list.
 *
 * @returns {Promise<Element>} The history section
 */
async function openLibraryHistory() {
  const Library = customElements.get("zen-library");
  Library.toggle("history");
  let section;
  await TestUtils.waitForCondition(() => {
    section = document.querySelector("zen-library-history-section");
    return section?.visits;
  }, "the library lists history");
  return section;
}

async function closeLibrary() {
  const Library = customElements.get("zen-library");
  Library.toggle("history");
  await TestUtils.waitForCondition(
    () => !Library.isLibraryOpen && Library.libraryProgress === 0,
    "library closes"
  );
}

/**
 * @param {Element} section - The library's history section
 * @returns {string[]} The urls its rows link to
 */
function libraryURLs(section) {
  const urls = [];
  const visits = section.visits;
  for (const group of Array.isArray(visits) ? [visits] : visits.values()) {
    for (const visit of group) {
      urls.push(visit.url);
    }
  }
  return urls;
}
