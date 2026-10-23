/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.workspaces.separate-history", true],
      ["zen.library.history.closed-tabs", false],
    ],
  });
  await cleanUpHistory();
  registerCleanupFunction(cleanUpHistory);
});

async function waitForSpaceVisit(spaceId, url) {
  await TestUtils.waitForCondition(async () => {
    const visits = await ZenSpaceHistory.getVisits({ spaceId });
    return visits.some(v => v.url === url && v.title === PAGE_TITLE);
  }, `space ${spaceId} recorded ${url} with its title`);
}

async function spaceURLs(spaceId) {
  return (await ZenSpaceHistory.getVisits({ spaceId })).map(v => v.url);
}

add_task(async function test_each_space_keeps_its_own_history() {
  const firstSpace = gZenWorkspaces.activeWorkspace;
  const firstURL = pageURL("space-first");
  const firstTab = await openTabIn(firstURL, 0);
  await waitForSpaceVisit(firstSpace, firstURL);

  await gZenWorkspaces.createAndSaveWorkspace("History test space");
  const secondSpace = gZenWorkspaces.activeWorkspace;
  isnot(secondSpace, firstSpace, "the new space is active");
  const secondURL = pageURL("space-second");
  const secondTab = await openTabIn(secondURL, 0);
  await waitForSpaceVisit(secondSpace, secondURL);

  ok(
    !(await spaceURLs(firstSpace)).includes(secondURL),
    "the first space does not have the second space's visit"
  );
  ok(
    !(await spaceURLs(secondSpace)).includes(firstURL),
    "the second space does not have the first space's visit"
  );

  const section = await openLibraryHistory();
  await TestUtils.waitForCondition(
    () => libraryURLs(section).includes(secondURL),
    "the library lists the current space's visit"
  );
  ok(!libraryURLs(section).includes(firstURL), "and not the other space's");
  await closeLibrary();

  BrowserTestUtils.removeTab(secondTab);
  await gZenWorkspaces.removeWorkspace(secondSpace);
  await TestUtils.waitForCondition(
    async () => !(await spaceURLs(secondSpace)).length,
    "removing a space forgets its history"
  );
  ok(
    (await spaceURLs(firstSpace)).includes(firstURL),
    "the other space keeps its history"
  );

  BrowserTestUtils.removeTab(firstTab);
  await cleanUpHistory();
});
