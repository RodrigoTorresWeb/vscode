/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import nls = require('vs/nls');
import errors = require('vs/base/common/errors');
import { toErrorMessage } from 'vs/base/common/errorMessage';
import paths = require('vs/base/common/paths');
import { Action } from 'vs/base/common/actions';
import URI from 'vs/base/common/uri';
import { FileOperationError, FileOperationResult } from 'vs/platform/files/common/files';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ITextFileService, ISaveErrorHandler, ITextFileEditorModel } from 'vs/workbench/services/textfile/common/textfiles';
import { ServicesAccessor, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { TextFileEditorModel } from 'vs/workbench/services/textfile/common/textFileEditorModel';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { ResourceMap } from 'vs/base/common/map';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import { ResourceEditorInput } from 'vs/workbench/common/editor/resourceEditorInput';
import { IContextKeyService, IContextKey, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { FileOnDiskContentProvider } from 'vs/workbench/parts/files/common/files';
import { FileEditorInput } from 'vs/workbench/parts/files/common/editors/fileEditorInput';
import { IModelService } from 'vs/editor/common/services/modelService';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { SAVE_FILE_COMMAND_ID, REVERT_FILE_COMMAND_ID, SAVE_FILE_AS_COMMAND_ID, SAVE_FILE_AS_LABEL } from 'vs/workbench/parts/files/electron-browser/fileCommands';
import { createTextBufferFactoryFromSnapshot } from 'vs/editor/common/model/textModel';
import { INotificationService, INotificationHandle, INotificationActions, Severity } from 'vs/platform/notification/common/notification';

export const CONFLICT_RESOLUTION_CONTEXT = 'saveConflictResolutionContext';
export const CONFLICT_RESOLUTION_SCHEME = 'conflictResolution';

const conflictEditorHelp = nls.localize('userGuide', "Use the actions in the editor tool bar to either undo your changes or overwrite the content on disk with your changes");

// A handler for save error happening with conflict resolution actions
export class SaveErrorHandler implements ISaveErrorHandler, IWorkbenchContribution {
	private messages: ResourceMap<INotificationHandle>;
	private toUnbind: IDisposable[];
	private conflictResolutionContext: IContextKey<boolean>;
	private activeConflictResolutionResource: URI;

	constructor(
		@INotificationService private notificationService: INotificationService,
		@ITextFileService private textFileService: ITextFileService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@ITextModelService textModelService: ITextModelService,
		@ICommandService private commandService: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		this.toUnbind = [];
		this.messages = new ResourceMap<INotificationHandle>();
		this.conflictResolutionContext = new RawContextKey<boolean>(CONFLICT_RESOLUTION_CONTEXT, false).bindTo(contextKeyService);

		const provider = instantiationService.createInstance(FileOnDiskContentProvider);
		this.toUnbind.push(provider);

		const registrationDisposal = textModelService.registerTextModelContentProvider(CONFLICT_RESOLUTION_SCHEME, provider);
		this.toUnbind.push(registrationDisposal);

		// Hook into model
		TextFileEditorModel.setSaveErrorHandler(this);

		this.registerListeners();
	}

	private registerListeners(): void {
		this.toUnbind.push(this.textFileService.models.onModelSaved(e => this.onFileSavedOrReverted(e.resource)));
		this.toUnbind.push(this.textFileService.models.onModelReverted(e => this.onFileSavedOrReverted(e.resource)));
		this.toUnbind.push(this.editorGroupService.onEditorsChanged(() => this.onEditorsChanged()));
	}

	private onEditorsChanged(): void {
		let isActiveEditorSaveConflictResolution = false;
		let activeConflictResolutionResource: URI;

		const activeEditor = this.editorService.getActiveEditor();
		if (activeEditor && activeEditor.input instanceof DiffEditorInput && activeEditor.input.originalInput instanceof ResourceEditorInput && activeEditor.input.modifiedInput instanceof FileEditorInput) {
			const resource = activeEditor.input.originalInput.getResource();
			if (resource && resource.scheme === CONFLICT_RESOLUTION_SCHEME) {
				isActiveEditorSaveConflictResolution = true;
				activeConflictResolutionResource = activeEditor.input.modifiedInput.getResource();
			}
		}

		this.conflictResolutionContext.set(isActiveEditorSaveConflictResolution);
		this.activeConflictResolutionResource = activeConflictResolutionResource;
	}

	private onFileSavedOrReverted(resource: URI): void {
		const messageHandle = this.messages.get(resource);
		if (messageHandle) {
			messageHandle.dispose();
			this.messages.delete(resource);
		}
	}

	public onSaveError(error: any, model: ITextFileEditorModel): void {
		const fileOperationError = error as FileOperationError;
		const resource = model.getResource();

		let message: string;
		const actions: INotificationActions = { primary: [], secondary: [] };

		// Dirty write prevention
		if (fileOperationError.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE) {

			// If the user tried to save from the opened conflict editor, show its message again
			// Otherwise show the message that will lead the user into the save conflict editor.
			if (this.activeConflictResolutionResource && this.activeConflictResolutionResource.toString() === model.getResource().toString()) {
				message = conflictEditorHelp;
			} else {
				message = nls.localize('staleSaveError', "Failed to save '{0}': The content on disk is newer. Please compare your version with the one on disk.", paths.basename(resource.fsPath));

				actions.primary.push(new Action('workbench.files.action.resolveConflict', nls.localize('compareChanges', "Compare"), null, true, () => {
					if (!model.isDisposed()) {
						const name = paths.basename(resource.fsPath);
						const editorLabel = nls.localize('saveConflictDiffLabel', "{0} (on disk) ↔ {1} (in {2}) - Resolve save conflict", name, name, this.environmentService.appNameLong);

						return this.editorService.openEditor({ leftResource: URI.from({ scheme: CONFLICT_RESOLUTION_SCHEME, path: resource.fsPath }), rightResource: resource, label: editorLabel, options: { pinned: true } }).then(() => {
							pendingResolveSaveConflictMessages.push(this.notificationService.notify({ severity: Severity.Info, message: conflictEditorHelp })); // Inform user
						});
					}

					return TPromise.as(true);
				}));
			}
		}

		// Any other save error
		else {
			const isReadonly = fileOperationError.fileOperationResult === FileOperationResult.FILE_READ_ONLY;
			const triedToMakeWriteable = isReadonly && fileOperationError.options && fileOperationError.options.overwriteReadonly;
			const isPermissionDenied = fileOperationError.fileOperationResult === FileOperationResult.FILE_PERMISSION_DENIED;

			// Save Elevated
			if (isPermissionDenied || triedToMakeWriteable) {
				actions.primary.push(new Action('workbench.files.action.saveElevated', triedToMakeWriteable ? nls.localize('overwriteElevated', "Overwrite as Admin...") : nls.localize('saveElevated', "Retry as Admin..."), null, true, () => {
					if (!model.isDisposed()) {
						model.save({
							writeElevated: true,
							overwriteReadonly: triedToMakeWriteable
						}).done(null, errors.onUnexpectedError);
					}

					return TPromise.as(true);
				}));
			}

			// Overwrite
			else if (isReadonly) {
				actions.primary.push(new Action('workbench.files.action.overwrite', nls.localize('overwrite', "Overwrite"), null, true, () => {
					if (!model.isDisposed()) {
						model.save({ overwriteReadonly: true }).done(null, errors.onUnexpectedError);
					}

					return TPromise.as(true);
				}));
			}

			// Retry
			else {
				actions.primary.push(new Action('workbench.files.action.retry', nls.localize('retry', "Retry"), null, true, () => {
					return this.commandService.executeCommand(SAVE_FILE_COMMAND_ID, resource);
				}));
			}

			// Save As
			actions.primary.push(new Action('workbench.files.action.saveAs', SAVE_FILE_AS_LABEL, null, true, () => {
				return this.commandService.executeCommand(SAVE_FILE_AS_COMMAND_ID, resource);
			}));

			// Discard
			actions.primary.push(new Action('workbench.files.action.discard', nls.localize('discard', "Discard"), null, true, () => {
				return this.commandService.executeCommand(REVERT_FILE_COMMAND_ID, resource);
			}));

			if (isReadonly) {
				if (triedToMakeWriteable) {
					message = nls.localize('readonlySaveErrorAdmin', "Failed to save '{0}': File is write protected. Select 'Overwrite as Admin' to retry as administrator.", paths.basename(resource.fsPath));
				} else {
					message = nls.localize('readonlySaveError', "Failed to save '{0}': File is write protected. Select 'Overwrite' to attempt to remove protection.", paths.basename(resource.fsPath));
				}
			} else if (isPermissionDenied) {
				message = nls.localize('permissionDeniedSaveError', "Failed to save '{0}': Insufficient permissions. Select 'Retry as Admin' to retry as administrator.", paths.basename(resource.fsPath));
			} else {
				message = nls.localize('genericSaveError', "Failed to save '{0}': {1}", paths.basename(resource.fsPath), toErrorMessage(error, false));
			}
		}

		// Show message and keep function to hide in case the file gets saved/reverted
		this.messages.set(model.getResource(), this.notificationService.notify({ severity: Severity.Error, message, actions }));
	}

	public dispose(): void {
		this.toUnbind = dispose(this.toUnbind);

		this.messages.clear();
	}
}

const pendingResolveSaveConflictMessages: INotificationHandle[] = [];
function clearPendingResolveSaveConflictMessages(): void {
	while (pendingResolveSaveConflictMessages.length > 0) {
		pendingResolveSaveConflictMessages.pop().dispose();
	}
}

export const acceptLocalChangesCommand = (accessor: ServicesAccessor, resource: URI) => {
	const editorService = accessor.get(IWorkbenchEditorService);
	const resolverService = accessor.get(ITextModelService);
	const modelService = accessor.get(IModelService);

	const editor = editorService.getActiveEditor();
	const input = editor.input;
	const position = editor.position;

	resolverService.createModelReference(resource).then(reference => {
		const model = reference.object as ITextFileEditorModel;
		const localModelSnapshot = model.createSnapshot();

		clearPendingResolveSaveConflictMessages(); // hide any previously shown message about how to use these actions

		// Revert to be able to save
		return model.revert().then(() => {

			// Restore user value (without loosing undo stack)
			modelService.updateModel(model.textEditorModel, createTextBufferFactoryFromSnapshot(localModelSnapshot));

			// Trigger save
			return model.save().then(() => {

				// Reopen file input
				return editorService.openEditor({ resource: model.getResource() }, position).then(() => {

					// Clean up
					input.dispose();
					reference.dispose();
					editorService.closeEditor(position, input);
				});
			});
		});
	});
};

export const revertLocalChangesCommand = (accessor: ServicesAccessor, resource: URI) => {
	const editorService = accessor.get(IWorkbenchEditorService);
	const resolverService = accessor.get(ITextModelService);

	const editor = editorService.getActiveEditor();
	const input = editor.input;
	const position = editor.position;

	resolverService.createModelReference(resource).then(reference => {
		const model = reference.object as ITextFileEditorModel;

		clearPendingResolveSaveConflictMessages(); // hide any previously shown message about how to use these actions

		// Revert on model
		return model.revert().then(() => {

			// Reopen file input
			return editorService.openEditor({ resource: model.getResource() }, position).then(() => {

				// Clean up
				input.dispose();
				reference.dispose();
				editorService.closeEditor(position, input);
			});
		});
	});
};
