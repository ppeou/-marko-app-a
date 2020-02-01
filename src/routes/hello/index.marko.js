// Compiled using marko@4.18.39 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require("marko/src/html").t(__filename),
    marko_componentType = "/app-a$1.0.0/src/routes/hello/index.marko",
    marko_renderer = require("marko/src/runtime/components/renderer"),
    helpers_escape_xml = require("marko/src/runtime/html/helpers/escape-xml"),
    marko_escapeXml = helpers_escape_xml.x,
    stop_watch_template = require("./components/stop-watch"),
    marko_loadTag = require("marko/src/runtime/helpers/load-tag"),
    stop_watch_tag = marko_loadTag(stop_watch_template),
    site_layout_template = require("../../components/site-layout"),
    site_layout_tag = marko_loadTag(site_layout_template);

function render(input, out, __component, component, state) {
  var data = input;

  site_layout_tag({
      title: {
          renderBody: function(out) {
            out.w("Hello <strong>" +
              marko_escapeXml(input.params.name) +
              "!</strong>");
          }
        },
      content: {
          renderBody: function(out) {
            out.w("<section><h2>Routes</h2><p>The code for this page is at <code>~/src/routes/hello/index.marko</code>. To create a new route, you create a directory under <code>routes/</code> and put an <code>index.marko</code> in it.</p><p>Try creating a template at <code>~/src/routes/new/index.marko</code> with the following content:</p><pre><code>&lt;site-layout>\n    &lt;@title>A New Page!&lt;/@title>\n&lt;/site-layout></code></pre><p>Then come back and click <a href=\"/new\">this link</a>. &#127881;</p></section><section><h2>Parameters</h2><p>You might have noticed that even though <code>hello/index.marko</code> renders this page, the url is <b>/hello/routing</b>. So what's going on? Parameters!</p><p>Take a look at <code>hello/route.js</code> and you'll see it contains <code>exports.path = '/hello/:name'</code>.</p><p>Here, <code>:name</code> is an <a href=\"https://github.com/pillarjs/path-to-regexp\">express-style parameter</a> and becomes available as <code>input.params.name</code> within the template! We use this <b>name</b> in the title of the page. Try following one of these links or change the url directly and watch how the title changes:</p><ul><li><a href=\"/hello/world\">/hello/world</a></li><li><a href=\"/hello/marko\">/hello/marko</a></li></ul></section><section><h2>Scoped Components</h2><p>Here's another component, but this one is <i>scoped</i> to this page. You see, it lives in <code>~/src/routes/hello/components/</code> and therefore is only available to the <b>hello</b> page! &#128374;</p>");

            stop_watch_tag({}, out, __component, "40");

            out.w("</section>");
          }
        }
    }, out, __component, "0");
}

marko_template._ = marko_renderer(render, {
    ___implicit: true,
    ___type: marko_componentType
  });

marko_template.meta = {
    id: "/app-a$1.0.0/src/routes/hello/index.marko",
    tags: [
      "./components/stop-watch",
      "../../components/site-layout"
    ]
  };
