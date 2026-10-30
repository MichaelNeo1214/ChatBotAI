/* PDF.js 6 ships ES modules only, while the rest of the app is loaded as
   classic scripts. Start the module load here, keep a promise on `window` so
   the PDF extractor can await it, and configure the same-origin module worker.
   The path is versioned: an upgrade replaces the directory and this constant. */
'use strict';

(function () {
    var PDFJS_VERSION = '6.4.299';
    var base = '/vendor/pdfjs/' + PDFJS_VERSION + '/';

    window.pdfjsReady = import(base + 'pdf.min.mjs').then(function (lib) {
        lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
        window.pdfjsLib = lib;
        return lib;
    }).catch(function (error) {
        // Leave the promise resolved with null rather than rejecting: a failed
        // vendor load must degrade to "PDF unavailable", not an unhandled
        // rejection that breaks unrelated features.
        console.error('PDF.js failed to load:', error);
        return null;
    });
})();
