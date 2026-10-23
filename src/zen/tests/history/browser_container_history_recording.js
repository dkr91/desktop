/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ContextualIdentityService } = ChromeUtils.importESModule(
  "resource://gre/modules/ContextualIdentityService.sys.mjs"
);

add_setup(async function () {
  await cleanUpHistory();
  registerCleanupFunction(cleanUpHistory);
});

add_task(async function test_container_visits_stay_out_of_places() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.containers.separate-history", true]],
  });

  const containerURL = pageURL("container");
  const containerTab = await openTabIn(containerURL, 1);
  const browser = containerTab.linkedBrowser;
  is(
    browser.getAttribute("disableglobalhistory"),
    "true",
    "the container tab's browser does not use global history"
  );
  ok(
    !browser.browsingContext.useGlobalHistory,
    "nor does its browsing context"
  );

  const visit = await waitForContainerVisit(1, containerURL);
  is(visit.userContextId, 1, "the visit belongs to the container");
  ok(
    !(await PlacesUtils.history.hasVisits(containerURL)),
    "the container's visit is not in the global history"
  );

  const plainURL = pageURL("plain");
  const visited = PlacesTestUtils.waitForNotification("page-visited", events =>
    events.some(event => event.url === plainURL)
  );
  const plainTab = await openTabIn(plainURL, 0);
  ok(
    !plainTab.linkedBrowser.hasAttribute("disableglobalhistory"),
    "a tab outside containers uses global history"
  );
  await visited;
  ok(
    await PlacesUtils.history.hasVisits(plainURL),
    "a visit outside containers is in the global history"
  );
  const containerVisits = await ZenContainerHistory.getVisits({
    userContextId: 1,
  });
  ok(
    !containerVisits.some(v => v.url === plainURL),
    "the container's history does not have it"
  );

  BrowserTestUtils.removeTab(containerTab);
  BrowserTestUtils.removeTab(plainTab);
  await SpecialPowers.popPrefEnv();
  await cleanUpHistory();
});

add_task(async function test_turning_it_off_lets_tabs_back_in() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.containers.separate-history", true]],
  });
  const tab = await openTabIn(pageURL("toggle"), 2);
  ok(
    !tab.linkedBrowser.browsingContext.useGlobalHistory,
    "kept out while the pref is on"
  );

  await SpecialPowers.pushPrefEnv({
    set: [["zen.containers.separate-history", false]],
  });
  ok(
    !tab.linkedBrowser.hasAttribute("disableglobalhistory"),
    "the open tab is let back in"
  );
  ok(
    tab.linkedBrowser.browsingContext.useGlobalHistory,
    "and its browsing context uses global history again"
  );

  const url = pageURL("toggle-off");
  const visited = PlacesTestUtils.waitForNotification("page-visited", events =>
    events.some(event => event.url === url)
  );
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
  await visited;
  ok(
    await PlacesUtils.history.hasVisits(url),
    "with the pref off, a container's visit goes to the global history"
  );

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await cleanUpHistory();
});

add_task(async function test_removing_a_container_forgets_its_history() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.containers.separate-history", true]],
  });
  const identity = ContextualIdentityService.create(
    "History test",
    "fingerprint",
    "blue"
  );
  const { userContextId } = identity;
  const url = pageURL("removed");
  const tab = await openTabIn(url, userContextId);
  await waitForContainerVisit(userContextId, url);
  BrowserTestUtils.removeTab(tab);

  ContextualIdentityService.remove(userContextId);
  await TestUtils.waitForCondition(
    async () =>
      !(await ZenContainerHistory.getVisits({ userContextId })).length,
    "the removed container's history is forgotten"
  );

  await SpecialPowers.popPrefEnv();
  await cleanUpHistory();
});

add_task(async function test_clearing_history_clears_containers() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.containers.separate-history", true]],
  });
  const url = pageURL("cleared");
  const tab = await openTabIn(url, 1);
  await waitForContainerVisit(1, url);
  BrowserTestUtils.removeTab(tab);

  await PlacesUtils.history.clear();
  await TestUtils.waitForCondition(
    async () =>
      !(await ZenContainerHistory.getVisits({ userContextId: 1 })).length,
    "clearing all history clears the containers' too"
  );

  await SpecialPowers.popPrefEnv();
});
