// Compiled using marko@4.18.39 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require("marko/src/html").t(__filename),
    marko_component = {
        onCreate: function() {
          this.state = {
              count: 0
            };
        },
        increment: function() {
          this.state.count++;
        }
      },
    marko_componentType = "/app-a$1.0.0/src/components/click-count/index.marko",
    marko_renderer = require("marko/src/runtime/components/renderer"),
    helpers_escape_xml = require("marko/src/runtime/html/helpers/escape-xml"),
    marko_escapeXml = helpers_escape_xml.x;

function render(input, out, __component, component, state) {
  var data = input;

  out.w("<div class=\"count\">" +
    marko_escapeXml(state.count) +
    "</div><button class=\"example-button\">Click me!</button>");
}

marko_template._ = marko_renderer(render, {
    ___type: marko_componentType
  }, marko_component);

marko_template.meta = {
    deps: [
      {
          type: "css",
          code: ".count {\n    color: #70b;\n    font-size: 3em;\n  }\n  .example-button {\n    font-size: 1em;\n    padding: 0.5em;\n  }",
          virtualPath: "./index.marko.css",
          path: "./index.marko"
        }
    ],
    id: "/app-a$1.0.0/src/components/click-count/index.marko",
    component: "./"
  };
