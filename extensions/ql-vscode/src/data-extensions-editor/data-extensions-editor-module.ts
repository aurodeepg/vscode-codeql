import { ExtensionContext } from "vscode";
import { DataExtensionsEditorView } from "./data-extensions-editor-view";
import { DataExtensionsEditorCommands } from "../common/commands";
import { CliVersionConstraint, CodeQLCliServer } from "../codeql-cli/cli";
import { QueryRunner } from "../query-server";
import { DatabaseManager } from "../databases/local-databases";
import { ensureDir } from "fs-extra";
import { join } from "path";
import { App } from "../common/app";
import { withProgress } from "../common/vscode/progress";
import { pickExtensionPack } from "./extension-pack-picker";
import { showAndLogErrorMessage } from "../common/logging";

const SUPPORTED_LANGUAGES: string[] = ["java", "csharp"];

export class DataExtensionsEditorModule {
  private readonly queryStorageDir: string;

  private constructor(
    private readonly ctx: ExtensionContext,
    private readonly app: App,
    private readonly databaseManager: DatabaseManager,
    private readonly cliServer: CodeQLCliServer,
    private readonly queryRunner: QueryRunner,
    baseQueryStorageDir: string,
  ) {
    this.queryStorageDir = join(
      baseQueryStorageDir,
      "data-extensions-editor-results",
    );
  }

  public static async initialize(
    ctx: ExtensionContext,
    app: App,
    databaseManager: DatabaseManager,
    cliServer: CodeQLCliServer,
    queryRunner: QueryRunner,
    queryStorageDir: string,
  ): Promise<DataExtensionsEditorModule> {
    const dataExtensionsEditorModule = new DataExtensionsEditorModule(
      ctx,
      app,
      databaseManager,
      cliServer,
      queryRunner,
      queryStorageDir,
    );

    await dataExtensionsEditorModule.initialize();
    return dataExtensionsEditorModule;
  }

  public getCommands(): DataExtensionsEditorCommands {
    return {
      "codeQL.openDataExtensionsEditor": async () => {
        const db = this.databaseManager.currentDatabaseItem;
        if (!db) {
          void showAndLogErrorMessage(this.app.logger, "No database selected");
          return;
        }

        if (!SUPPORTED_LANGUAGES.includes(db.language)) {
          void showAndLogErrorMessage(
            this.app.logger,
            `The data extensions editor is not supported for ${db.language} databases.`,
          );
          return;
        }

        return withProgress(
          async (progress, token) => {
            if (!(await this.cliServer.cliConstraints.supportsQlpacksKind())) {
              void showAndLogErrorMessage(
                this.app.logger,
                `This feature requires CodeQL CLI version ${CliVersionConstraint.CLI_VERSION_WITH_QLPACKS_KIND.format()} or later.`,
              );
              return;
            }

            if (
              !(await this.cliServer.cliConstraints.supportsResolveExtensions())
            ) {
              void showAndLogErrorMessage(
                this.app.logger,
                `This feature requires CodeQL CLI version ${CliVersionConstraint.CLI_VERSION_WITH_RESOLVE_EXTENSIONS.format()} or later.`,
              );
              return;
            }

            const modelFile = await pickExtensionPack(
              this.cliServer,
              db,
              this.app.logger,
              progress,
              token,
            );
            if (!modelFile) {
              return;
            }

            // TODO: Copy the files to a temporary directory and install pack dependencies

            const queryDir = (await dir({ unsafeCleanup: true })).path;

            // TODO: Write both the application mode and framework mode query
            const queryFile = join(queryDir, "FetchExternalApis.ql");
            await writeFile(queryFile, query[queryName], "utf8");

            if (query.dependencies) {
              for (const [filename, contents] of Object.entries(
                query.dependencies,
              )) {
                const dependencyFile = join(queryDir, filename);
                await writeFile(dependencyFile, contents, "utf8");
              }
            }

            const syntheticQueryPack = {
              name: "codeql/external-api-usage",
              version: "0.0.0",
              dependencies: {
                [`codeql/${databaseItem.language}-all`]: "*",
              },
            };

            const qlpackFile = join(queryDir, "codeql-pack.yml");
            await writeFile(qlpackFile, dumpYaml(syntheticQueryPack), "utf8");

            // TODO: install pack dependencies in temporary file (`codeql pack install`)

            const view = new DataExtensionsEditorView(
              this.ctx,
              this.app,
              this.databaseManager,
              this.cliServer,
              this.queryRunner,
              this.queryStorageDir,
              queryDir,
              db,
              modelFile,
            );
            await view.openView();
          },
          {
            title: "Opening Data Extensions Editor",
          },
        );
      },
    };
  }

  private async initialize(): Promise<void> {
    await ensureDir(this.queryStorageDir);
  }
}
