/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PAGE_URL =
  "chrome://browser/content/zen-components/zen-about-history.html";

/**
 * about:history, which takes the tab to the history of Firefox View. Opened
 * in a container whose history is kept apart, that shows the container's own
 * history (see ZenContainerHistory.sys.mjs).
 */
export class ZenAboutHistory {
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(PAGE_URL),
      loadInfo
    );
    channel.originalURI = uri;
    return channel;
  }

  getURIFlags() {
    // No CAN_ or MUST_LOAD_IN_CHILD, so it loads in the parent, as Firefox
    // View does.
    return (
      Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI
    );
  }

  getChromeURI() {
    return Services.io.newURI(PAGE_URL);
  }
}
