const async = require('async');
const path  = require('path');
const fs    = require('fs');
const _     = require('lodash');

const Options  = require('./Options');
const Release  = require('./Release');
const Remote   = require('./Remote');
const Archiver = require('./Archiver');

const logger = require('./logger');
const utils  = require('./utils');


module.exports = class {

    constructor(options) {
        this.options = new Options(options).get();

        this.release = new Release(
            this.options,
            Options.defaultOptions()
        );

        this.remote = new Remote(this.options);

        this.logger = logger;
        this.logger.setDebug(this.options.debug);

        this.context = {
            options: this.options,
            release: this.release,
            logger: this.logger,
            remote: {
                exec: (command, done, showLog) => {
                    this.remote.exec(command, done, showLog);
                },
                execMultiple: (commands, done, showLog) => {
                    this.remote.execMultiple(commands, done, showLog);
                },
                upload: (src, target, done) => {
                    this.remote.upload(src, target, done);
                },
                createSymboliclink: (target, link, done) => {
                    this.remote.createSymboliclink(target, link, done);
                },
                chmod: (path, mode, done) => {
                    this.remote.chmod(path, mode, done);
                },
                createFolder: (path, done) => {
                    this.remote.createFolder(path, done);
                },
            },

            // 1.x.x compatibility
            // @deprecated
            releaseTag: this.release.tag,
            // @deprecated
            releaseName: this.release.name,
            // @deprecated
            execRemote: (cmd, showLog, done) => {
                this.remote.exec(cmd, done, showLog);
            },
        };
    }


    noop() {
        // Nothing
    }


    /**
     * Deploy release
     */
    deployRelease(done) {
        done = done || this.noop;

        async.series([
            this.connectToRemoteTask.bind(this),
            this.onBeforeDeployTask.bind(this),
            this.onBeforeDeployExecuteTask.bind(this),
            this.compressReleaseTask.bind(this),
            this.createReleaseFolderOnRemoteTask.bind(this),
            this.uploadArchiveTask.bind(this),
            this.uploadReleaseTask.bind(this),
            this.decompressArchiveOnRemoteTask.bind(this),
            this.onBeforeLinkTask.bind(this),
            this.onBeforeLinkExecuteTask.bind(this),
            this.updateSharedSymbolicLinkOnRemoteTask.bind(this),
            this.createFolderTask.bind(this),
            this.makeDirectoriesWritableTask.bind(this),
            this.makeFilesExecutableTask.bind(this),
            this.updateCurrentSymbolicLinkOnRemoteTask.bind(this),
            this.onAfterDeployTask.bind(this),
            this.onAfterDeployExecuteTask.bind(this),
            this.remoteCleanupTask.bind(this),
            this.deleteLocalArchiveTask.bind(this),
            this.closeConnectionTask.bind(this),
        ], function () {
            done();
        });
    }


    /**
     * Remove release
     */
    removeRelease(done) {
        done = done || this.noop;

        async.series([
            this.connectToRemoteTask.bind(this),
            this.removeReleaseTask.bind(this),
            this.closeConnectionTask.bind(this),
        ], function () {
            done();
        });
    }


    // =======================================================================================

    /**
     * @param done
     */
    onBeforeDeployTask(done) {
        this.options.onBeforeDeploy(this.context, done);
    }

    /**
     * @param done
     */
    onBeforeDeployExecuteTask(done) {
        this.middlewareCallbackExecute(this.options.onBeforeDeployExecute, done);
    }

    /**
     *
     * @param done
     */
    compressReleaseTask(done) {

        if (this.options.mode != 'archive') {
            done();
            return;
        }

        logger.subhead('Compress release');
        let spinner = logger.startSpinner('Compressing');

        let archiver = this.createArchiver(
            this.options.archiveType,
            this.options.archiveName,
            this.options.localPath,
            this.options.exclude
        );

        archiver.compress(
            (fileSize) => {
                spinner.stop();
                logger.ok('Archive created : ' + fileSize);
                done();
            },
            (err) => {
                spinner.stop();
                logger.error('Error while compressing');
                throw err;
            }
        )
    }

    /**
     *
     * @param done
     */
    connectToRemoteTask(done) {
        this.logger.subhead('Connect to ' + this.options.host);
        const spinner = this.logger.startSpinner('Connecting');

        this.remote = this.createRemote(
            this.options,
            this.logger,
            (command, error) => {
                console.log(command);
                this.logger.error('Connection error', command, error);

                // Clean up remote release + close connection
                //    this.removeReleaseTask(this.closeConnectionTask(done));
            }
        );

        this.remote.connect(
            // Success
            () => {
                spinner.stop();
                this.logger.ok('Connected');
                done();
            },
            // Error
            (error) => {
                spinner.stop();
                if (error) {
                    this.logger.fatal(error);
                }
            },
            // Close
            () => {
                this.logger.subhead("Closed from " + this.options.host);
            }
        );
    }

    /**
     *
     * @param done
     */
    createReleaseFolderOnRemoteTask(done) {
        this.logger.subhead('Create release folder on remote');
        this.logger.log(' - ' + this.release.path);

        this.remote.createFolder(this.release.path, () => {
            this.logger.ok('Done');
            done();
        });
    }

    /**
     *
     * @param done
     */
    uploadArchiveTask(done) {
        if (this.options.mode != 'archive') {
            done();
            return;
        }

        this.logger.subhead('Upload archive to remote');
        let spinner = this.logger.startSpinner('Uploading');

        this.remote.upload(
            this.options.archiveName,
            this.release.path,
            (error) => {
                spinner.stop();

                if (error) {
                    logger.error(error);
                    return;
                }

                this.logger.ok('Done');
                done();
            }
        );
    }

    /**
     *
     * @param done
     */
    uploadReleaseTask(done) {

        if (this.options.mode != 'synchronize') {
            done();
            return;
        }

        this.logger.subhead('Synchronize remote server');
        const spinner = this.logger.startSpinner('Synchronizing');

        this.remote.synchronize(
            this.options.localPath,
            this.release.path,
            this.options.deployPath + '/' + this.options.synchronizedFolder,
            () => {
                spinner.stop();
                this.logger.ok('Done');
                done();
            }
        );
    }

    /**
     *
     * @param done
     */
    decompressArchiveOnRemoteTask(done) {
        if (this.options.mode != 'archive') {
            done();
            return;
        }

        this.logger.subhead('Decompress archive on remote');
        let spinner = this.logger.startSpinner('Decompressing');

        const archivePath = path.posix.join(this.release.path, this.options.archiveName);
        const untarMap    = {
            'zip': "unzip -q " + archivePath + " -d " + this.release.path + "/",
            'tar': "tar -xvf " + archivePath + " -C " + this.release.path + "/",
        };

        // Check archiveType is supported
        if (!untarMap[this.options.archiveType]) {
            logger.fatal(this.options.archiveType + ' not supported.');
        }

        const command = [
            untarMap[this.options.archiveType],
            "rm " + archivePath,
        ].join('\n');

        this.remote.exec(command, () => {
            spinner.stop();
            this.logger.ok('Done');
            done();
        });
    }

    /**
     *
     * @param done
     */
    onBeforeLinkTask(done) {
        this.options.onBeforeLink(this.context, done);
    }

    /**
     *
     * @param done
     */
    onBeforeLinkExecuteTask(done) {
        this.middlewareCallbackExecute(this.options.onBeforeLinkExecute, done);
    }

    /**
     *
     * @param done
     */
    updateSharedSymbolicLinkOnRemoteTask(done) {

        if (!this.options.share || this.options.share.length == 0) {
            done();
            return;
        }

        this.logger.subhead('Update shared symlink on remote');

        async.eachSeries(
            Object.keys(this.options.share),
            (currentSharedFolder, itemDone) => {
                const configValue = this.options.share[currentSharedFolder];
                let symlinkName   = configValue;
                let mode          = null;

                if (
                    typeof configValue == 'object'
                    && 'symlink' in configValue
                ) {
                    symlinkName = configValue.symlink;
                }

                if (
                    typeof configValue == 'object'
                    && 'mode' in configValue
                ) {
                    mode = configValue.mode;
                }

                const linkPath   = this.release.path + '/' + symlinkName;
                const upwardPath = utils.getReversePath(symlinkName);
                const target     = upwardPath + '/../' + this.options.sharedFolder + '/' + currentSharedFolder;

                this.logger.log(' - ' + symlinkName + ' ==> ' + currentSharedFolder);
                this.remote.createSymboliclink(target, linkPath, () => {
                    if (!mode) {
                        itemDone();
                        return;
                    }

                    this.logger.log('   chmod ' + mode);
                    this.remote.chmod(linkPath, mode, () => {
                        itemDone();
                    });
                });
            },
            () => {
                this.logger.ok('Done');
                done();
            }
        );
    }

    /**
     *
     * @param done
     */
    createFolderTask(done) {

        if (!this.options.create || this.options.create.length == 0) {
            done();
            return;
        }

        this.logger.subhead('Create folders on remote');

        async.eachSeries(
            this.options.create,
            (currentFolderToCreate, itemDone) => {
                const path = this.release.path + '/' + currentFolderToCreate;
                this.logger.log(' - ' + currentFolderToCreate);

                this.remote.createFolder(path, itemDone);
            },
            () => {
                this.logger.ok('Done');
                done();
            }
        );
    }

    /**
     *
     * @param done
     */
    makeDirectoriesWritableTask(done) {
        if (!this.options.makeWritable || this.options.makeWritable.length == 0) {
            done();
            return;
        }

        this.logger.subhead('Make folders writable on remote');

        async.eachSeries(
            this.options.makeWritable,
            (currentFolderToMakeWritable, itemDone) => {
                const path = this.release.path + '/' + currentFolderToMakeWritable;
                const mode = 'ugo+w';

                this.logger.log(' - ' + currentFolderToMakeWritable);
                this.remote.chmod(path, mode, itemDone);
            },
            () => {
                this.logger.ok('Done');
                done();
            }
        );
    }

    /**
     *
     * @param done
     */
    makeFilesExecutableTask(done) {
        if (!this.options.makeExecutable || this.options.makeExecutable.length == 0) {
            done();
            return;
        }

        this.logger.subhead('Make files executables on remote');

        async.eachSeries(
            this.options.makeExecutable,
            (currentFileToMakeExecutable, itemDone) => {
                const path    = this.release.path + '/' + currentFileToMakeExecutable;
                const command = 'chmod ugo+x ' + path;

                this.logger.log(' - ' + currentFileToMakeExecutable);
                this.remote.exec(command, itemDone);
            }, () => {
                this.logger.ok('Done');
                done();
            });
    }

    /**
     *
     * @param done
     */
    updateCurrentSymbolicLinkOnRemoteTask(done) {
        this.logger.subhead('Update current release symlink on remote');

        const target      = this.options.releasesFolder + '/' + this.release.tag;
        const currentPath = path.posix.join(this.options.deployPath, this.options.currentReleaseLink);

        this.remote.createSymboliclink(
            target,
            currentPath,
            () => {
                logger.ok('Done');
                done();
            }
        );
    }

    /**
     *
     * @param done
     */
    onAfterDeployTask(done) {
        this.options.onAfterDeploy(this.context, done);
    }

    /**
     *
     * @param done
     */
    onAfterDeployExecuteTask(done) {
        this.middlewareCallbackExecute(this.options.onAfterDeployExecute, done);
    }

    /**
     *
     * @param done
     */
    remoteCleanupTask(done) {

        this.logger.subhead('Remove old builds on remote');
        let spinner = this.logger.startSpinner('Removing');

        if (this.options.releasesToKeep < 1) {
            this.options.releasesToKeep = 1;
        }

        const folder = path.posix.join(
            this.options.deployPath,
            this.options.releasesFolder
        );

        this.remote.removeOldFolders(
            folder,
            this.options.releasesToKeep,
            () => {
                spinner.stop();
                this.logger.ok('Done');
                done();
            }
        )
    }

    /**
     *
     * @param done
     */
    deleteLocalArchiveTask(done) {
        if (this.options.mode != 'archive' || !this.options.deleteLocalArchiveAfterDeployment) {
            done();
            return;
        }

        logger.subhead('Delete local archive');
        fs.unlink(this.options.archiveName);
        logger.ok('Done');
        done();
    }

    /**
     *
     * @param done
     */
    closeConnectionTask(done) {
        this.remote.close(done);
    }


    /**
     * Remove release on remote
     * @param done
     */
    removeReleaseTask(done) {
        this.logger.subhead('Remove releases on remote');

        const command = "rm -rf " + this.options.deployPath;
        this.remote.exec(command, () => {
            this.logger.ok('Done');
            done();
        });
    }


    // ================================================================


    /**
     * Execute commandsFunction results
     * @param commandsFunction function | []
     * @param callback
     */
    middlewareCallbackExecute(commandsFunction, callback) {
        if (!commandsFunction) {
            callback();
            return;
        }

        let commands = commandsFunction;

        // If commandsFunction is a function, take its result as commands
        if (typeof commandsFunction === 'function') {
            commands = commandsFunction(this.context);
        }

        // Nothing to execute
        if (!commands || commands.length == 0) {
            callback();
            return;
        }

        // Execute each command
        async.eachSeries(commands, (command, innerCallback) => {
            this.logger.subhead('Execute on remote : ' + command);
            this.remote.exec(command, innerCallback, true);
        }, () => {
            this.logger.ok('Done');
            callback();
        });
    }


    /**
     * Archiver factory
     * @param archiveType
     * @param archiveName
     * @param localPath
     * @param exclude
     * @returns {Archiver}
     */
    createArchiver(archiveType, archiveName, localPath, exclude) {
        return new Archiver(
            archiveType,
            archiveName,
            localPath,
            exclude
        );
    }
    ;


    /**
     * Remote factory
     */
    createRemote(options, logger, onError) {
        return new Remote(options, logger, onError);
    }

};