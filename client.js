var helloComponent = require("./index");

helloComponent.renderSync({ name: "Marko" }).appendTo(document.body);
