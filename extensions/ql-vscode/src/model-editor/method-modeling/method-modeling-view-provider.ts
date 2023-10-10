import {
  FromMethodModelingMessage,
  ToMethodModelingMessage,
} from "../../common/interface-types";
import { telemetryListener } from "../../common/vscode/telemetry";
import { showAndLogExceptionWithTelemetry } from "../../common/logging/notifications";
import { extLogger } from "../../common/logging/vscode/loggers";
import { App } from "../../common/app";
import { redactableError } from "../../common/errors";
import { Method } from "../method";
import { ModelingStore } from "../modeling-store";
import { AbstractWebviewViewProvider } from "../../common/vscode/abstract-webview-view-provider";
import { assertNever } from "../../common/helpers-pure";
import { ModelEditorViewTracker } from "../model-editor-view-tracker";
import { ModelConfigListener } from "../../config";
import { DatabaseItem } from "../../databases/local-databases";
import {
  convertFromLegacyModeledMethod,
  convertToLegacyModeledMethod,
} from "../shared/modeled-methods-legacy";

export class MethodModelingViewProvider extends AbstractWebviewViewProvider<
  ToMethodModelingMessage,
  FromMethodModelingMessage
> {
  public static readonly viewType = "codeQLMethodModeling";

  private method: Method | undefined = undefined;
  private databaseItem: DatabaseItem | undefined = undefined;

  constructor(
    app: App,
    private readonly modelingStore: ModelingStore,
    private readonly editorViewTracker: ModelEditorViewTracker,
    private readonly modelConfig: ModelConfigListener,
  ) {
    super(app, "method-modeling");
  }

  protected override async onWebViewLoaded(): Promise<void> {
    await Promise.all([this.setViewState(), this.setInitialState()]);
    this.registerToModelingStoreEvents();
    this.registerToModelConfigEvents();
  }

  private async setViewState(): Promise<void> {
    await this.postMessage({
      t: "setMethodModelingPanelViewState",
      viewState: {
        showMultipleModels: this.modelConfig.showMultipleModels,
      },
    });
  }

  public async setMethod(
    databaseItem: DatabaseItem | undefined,
    method: Method | undefined,
  ): Promise<void> {
    this.method = method;
    this.databaseItem = databaseItem;

    if (this.isShowingView) {
      await this.postMessage({
        t: "setMethod",
        method,
      });
    }
  }

  private async setInitialState(): Promise<void> {
    if (this.modelingStore.hasStateForActiveDb()) {
      const selectedMethod = this.modelingStore.getSelectedMethodDetails();
      if (selectedMethod) {
        await this.postMessage({
          t: "setSelectedMethod",
          method: selectedMethod.method,
          modeledMethod: convertToLegacyModeledMethod(
            selectedMethod.modeledMethods,
          ),
          isModified: selectedMethod.isModified,
        });
      }

      await this.postMessage({
        t: "setInModelingMode",
        inModelingMode: true,
      });
    }
  }

  protected override async onMessage(
    msg: FromMethodModelingMessage,
  ): Promise<void> {
    switch (msg.t) {
      case "viewLoaded":
        await this.onWebViewLoaded();
        break;

      case "telemetry":
        telemetryListener?.sendUIInteraction(msg.action);
        break;

      case "unhandledError":
        void showAndLogExceptionWithTelemetry(
          extLogger,
          telemetryListener,
          redactableError(
            msg.error,
          )`Unhandled error in method modeling view: ${msg.error.message}`,
        );
        break;

      case "setModeledMethod": {
        if (!this.databaseItem) {
          return;
        }

        this.modelingStore.updateModeledMethods(
          this.databaseItem,
          msg.method.signature,
          convertFromLegacyModeledMethod(msg.method),
        );
        this.modelingStore.addModifiedMethod(
          this.databaseItem,
          msg.method.signature,
        );
        break;
      }
      case "revealInModelEditor":
        await this.revealInModelEditor(msg.method);

        break;

      case "startModeling":
        await this.app.commands.execute(
          "codeQL.openModelEditorFromModelingPanel",
        );
        break;
      default:
        assertNever(msg);
    }
  }

  private async revealInModelEditor(method: Method): Promise<void> {
    if (!this.databaseItem) {
      return;
    }

    const views = this.editorViewTracker.getViews(
      this.databaseItem.databaseUri.toString(),
    );
    if (views.length === 0) {
      return;
    }

    await Promise.all(views.map((view) => view.revealMethod(method)));
  }

  private registerToModelingStoreEvents(): void {
    this.push(
      this.modelingStore.onModeledMethodsChanged(async (e) => {
        if (this.webviewView && e.isActiveDb) {
          const modeledMethods = e.modeledMethods[this.method?.signature ?? ""];
          if (modeledMethods) {
            const modeledMethod = convertToLegacyModeledMethod(modeledMethods);
            if (modeledMethod) {
              await this.postMessage({
                t: "setModeledMethod",
                method: modeledMethod,
              });
            }
          }
        }
      }),
    );

    this.push(
      this.modelingStore.onModifiedMethodsChanged(async (e) => {
        if (this.webviewView && e.isActiveDb && this.method) {
          const isModified = e.modifiedMethods.has(this.method.signature);
          await this.postMessage({
            t: "setMethodModified",
            isModified,
          });
        }
      }),
    );

    this.push(
      this.modelingStore.onSelectedMethodChanged(async (e) => {
        if (this.webviewView) {
          this.method = e.method;
          this.databaseItem = e.databaseItem;

          await this.postMessage({
            t: "setSelectedMethod",
            method: e.method,
            modeledMethod: convertToLegacyModeledMethod(e.modeledMethods),
            isModified: e.isModified,
          });
        }
      }),
    );

    this.push(
      this.modelingStore.onDbOpened(async () => {
        await this.postMessage({
          t: "setInModelingMode",
          inModelingMode: true,
        });
      }),
    );

    this.push(
      this.modelingStore.onDbClosed(async (dbUri) => {
        if (!this.modelingStore.anyDbsBeingModeled()) {
          await this.postMessage({
            t: "setInModelingMode",
            inModelingMode: false,
          });
        }

        if (dbUri === this.databaseItem?.databaseUri.toString()) {
          await this.setMethod(undefined, undefined);
        }
      }),
    );
  }

  private registerToModelConfigEvents(): void {
    this.push(
      this.modelConfig.onDidChangeConfiguration(() => {
        void this.setViewState();
      }),
    );
  }
}
