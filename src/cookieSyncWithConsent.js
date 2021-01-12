/**
 * This script runs the Prebid Server cookie syncs.
 * For more details, see https://github.com/prebid/prebid-server/blob/master/docs/developers/cookie-syncs.md
 *
 * This script uses the following query params in the URL:
 *
 *   max_sync_count (optional): The number of syncs allowed on the page. If present, this should be a positive integer.
 *
 *   endpoint (optional): The endpoint to handle bidder sync. If present, this should be a defined property in VALID_ENDPOINTS.
 */
import * as domHelper from './domHelper';

const VALID_ENDPOINTS = {
    rubicon: 'https://prebid-server.rubiconproject.com/cookie_sync',
    appnexus: 'https://prebid.adnxs.com/pbs/v1/cookie_sync'
};
const ENDPOINT = sanitizeEndpoint(parseQueryParam('endpoint', window.location.search));
const ENDPOINT_ARGS = sanitizeEndpointArgs(parseQueryParam('args', window.location.search));
const maxSyncCountParam = parseQueryParam('max_sync_count', window.location.search);
const MAX_SYNC_COUNT = sanitizeSyncCount(parseInt((maxSyncCountParam) ? maxSyncCountParam : 10, 10));
const TIMEOUT = sanitizeTimeout(parseInt(parseQueryParam('timeout', window.location.search), 10));
const DEFAULT_GDPR_SCOPE = sanitizeScope(parseInt(parseQueryParam('defaultGdprScope', window.location.search), 10));

let consent = {};
let syncRan = false;
/**
 * checks to make sure URL is valid. Regex from https://validatejs.org/#validators-url, https://gist.github.com/dperini/729294
 */
const isValidUrl = new RegExp(/^(?:(?:(?:https?|ftp):)?\/\/)(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u00a1-\uffff][a-z0-9\u00a1-\uffff_-]{0,62})?[a-z0-9\u00a1-\uffff]\.)+(?:[a-z\u00a1-\uffff]{2,}\.?))(?::\d{2,5})?(?:[/?#]\S*)?$/i);


function doBidderSync(type, url, bidder, done) {
    if (!url || !isValidUrl.test(url)) {
        console.log(`No valid sync url for bidder "${bidder}": ${url}`);
        done();
    } else if (type === 'image' || type === 'redirect') {
        console.log(`Invoking image pixel user sync for bidder: "${bidder}"`);
        triggerPixel(url, done);
    } else if (type == 'iframe') {
        console.log(`Invoking iframe pixel user sync for bidder: "${bidder}"`);
        triggerIframeLoad(url, bidder, done);
    } else {
        console.log(`User sync type "${type}" not supported for bidder: "${bidder}"`);
        done();
    }
}

function triggerIframeLoad(url, bidder, done) {
    if (!url) {
        return;
    }
    let iframe = domHelper.getEmptyIframe(0, 0);
    iframe.id = `sync_${bidder}_${Date.now()}`;
    iframe.src = url;
    iframe.onload = done;
    // we aren't listening to onerror because it won't fire for x-domain sources
    // however, in the event that the URL can't be resolved, the browser still invokes onload
    domHelper.insertElement(iframe, document, 'html');
}

function triggerPixel(url, done) {
    const img = new Image();
    img.addEventListener('load', done);
    img.addEventListener('error', done);
    img.src = url;
}

function doAllSyncs(bidders) {
    if (bidders.length === 0) {
        return;
    }

    const thisSync = bidders.pop();
    if (thisSync.no_cookie) {
        doBidderSync(thisSync.usersync.type, thisSync.usersync.url, thisSync.bidder, doAllSyncs.bind(null, bidders));
    } else {
        doAllSyncs(bidders);
    }
}

function process(response) {
    let result = JSON.parse(response);
    if (result.status === 'ok' || result.status === 'no_cookie') {
        if (result.bidder_status) {
            doAllSyncs(result.bidder_status);
        }
    }
}

function ajax(url, callback, data, options = {}) {
    try {
        let timeout = 3000;
        let x;
        let method = options.method || (data ? 'POST' : 'GET');

        let callbacks = typeof callback === 'object' ? callback : {
            success: function() {
                console.log('xhr success');
            },
            error: function(e) {
                console.log('xhr error', null, e);
            }
        };

        if (typeof callback === 'function') {
            callbacks.success = callback;
        }

        x = new window.XMLHttpRequest();
        x.onreadystatechange = function() {
            if (x.readyState === 4) {
                let status = x.status;
                if ((status >= 200 && status < 300) || status === 304) {
                    callbacks.success(x.responseText, x);
                } else {
                    callbacks.error(x.statusText, x);
                }
            }
        };
        x.ontimeout = function() {
            console.log('xhr timeout after ', x.timeout, 'ms');
        };

        if (method === 'GET' && data) {
            let urlInfo = parseURL(url, options);
            Object.assign(urlInfo.search, data);
            url = formatURL(urlInfo);
        }

        x.open(method, url);
        // IE needs timoeut to be set after open - see #1410
        x.timeout = timeout;

        if (options.withCredentials) {
            x.withCredentials = true;
        }
        if (options.preflight) {
            x.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        }
        x.setRequestHeader('Content-Type', options.contentType || 'text/plain');

        if (method === 'POST' && data) {
            x.send(data);
        } else {
            x.send();
        }
    } catch (error) {
        console.log('xhr construction', error);
    }
}

/**
 * Parse a query param value from the window.location.search string.
 * Implementation comes from: https://davidwalsh.name/query-string-javascript
 *
 * @param {string} name The name of the query param you want the value for.
 * @param {string} urlSearch The search string in the URL: window.location.search
 * @return {string} The value of the "name" query param.
 */
function parseQueryParam(name, urlSearch) {
    var regex = new RegExp('[\\?&]' + name + '=([^&#]*)');
    var results = regex.exec(urlSearch);
    return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
};

/**
 * If the value is a valid url (string and is defined in VALID_ENDPOINTS), return it.
 * Otherwise it will return a default value
 */
function sanitizeEndpoint(value) {
    return (value && VALID_ENDPOINTS.hasOwnProperty(value)) ? VALID_ENDPOINTS[value] : 'https://prebid.adnxs.com/pbs/v1/cookie_sync';
}

function sanitizeEndpointArgs(value) {
    if (value) {
        var argProperties = value.split(',').reduce(function(keyValues, key) {
            var keyValue = key.split(':');
            if (keyValue.length === 2 && keyValue[0] !== '' && keyValue[1] !== '') {
                keyValues[keyValue[0]] = /^\d+$/.test(keyValue[1]) ? parseInt(keyValue[1]) : keyValue[1];
            }
            return keyValues;
        }, {});
        return (argProperties && Object.keys(argProperties).length) ? argProperties : undefined;
    }
}

/**
 * If the value is a valid sync count (0 or a positive number), return it.
 * Otherwise return a really big integer (equivalent to "no sync").
 */
function sanitizeSyncCount(value) {
    if (isNaN(value) || value < 0) {
        return 9007199254740991 // Number.MAX_SAFE_INTEGER isn't supported in IE
    }
    return value;
}

/**
 * If the value is 0 or 1 return it.
 * Otherwise it will return default 1.
 */
function sanitizeScope(value) {
    if (value === 0 || value === 1) {
        return value;
    }
    return 1;
}

/**
 * If the value is 0 or 1 return it.
 * Otherwise it will return 10000.
 */
function sanitizeTimeout(value) {
    if (!isNaN(value) && value === parseInt(value, 10)) {
        return value;
    }
    return 10000;
}

/**
 * If the value is a non empty string return it.
 * Otherwise it will return undefined.
 */
function attachConsent(data) {
    if (consent.consentMetadata) {
        if (consent.consentMetadata.gdprApplies) {
            data.gdpr = 1;
            data.gdpr_consent = consent.consentString || "";
        } else {
            data.gdpr = 0;
        }
    }
    return data;
}

// Request MAX_SYNC_COUNT cookie syncs from prebid server.
// In next phase we will read placement id's from query param and will only get cookie sync status of bidders participating in auction

function getStringifiedData(endPointArgs) {
    var data = (endPointArgs && typeof endPointArgs === 'object') ? endPointArgs : {}
    data['limit'] = MAX_SYNC_COUNT;

    data = attachConsent(data);

    return JSON.stringify(data);
}

function init() {
    syncRan = true;
    ajax(ENDPOINT, process, getStringifiedData(ENDPOINT_ARGS), {
        withCredentials: true
    });
}

let timeout = setTimeout(function() {
    if (!syncRan) {
        if (!DEFAULT_GDPR_SCOPE) init();
        console.log("Message listener timed out. No consent data was returned.");
    }
}, TIMEOUT);

window.addEventListener('message', (event) => {
    if (event.data.type === 'consent-data') {
        consent = event.data;
        clearTimeout(timeout);
        if (!syncRan) {
            init();
        }
    }

}, false);

window.parent.postMessage({
    sentinel: 'amp',
    type: 'send-consent-data'
}, '*');