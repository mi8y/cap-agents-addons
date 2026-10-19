sap.ui.define(["sap/ui/core/UIComponent"], (UIComponent, models) => {
  "use strict";

  return UIComponent.extend("examples.cap.agents.sdmbackend.Component", {
    metadata: {
      manifest: "json",
      interfaces: ["sap.ui.core.IAsyncContentCreation"],
    },

    init() {
      // call the base component's init function
      UIComponent.prototype.init.apply(this, arguments);
    },
  });
});
