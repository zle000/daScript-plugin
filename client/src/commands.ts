import { Disposable, ExtensionContext, commands } from 'vscode';
import { ExecuteCommandRequest, LanguageClient, RequestType } from 'vscode-languageclient/node';


export function registerClientCommands(context: ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(
        ...registerValidateCommand(client)
    );
}

function registerValidateCommand(client: LanguageClient): Disposable[] {
    return [
        commands.registerCommand(
            'dascript.revalidateWorkspace',
            async () => await client.sendRequest(
                new RequestType(ExecuteCommandRequest.method),
                {command: 'revalidateWorkspace'}
            )
        ),
        commands.registerCommand(
            'dascript.clearValidationCache',
            async () => await client.sendRequest(
                new RequestType(ExecuteCommandRequest.method),
                {command: 'clearValidationCache'}
            )
        )
    ]
}
