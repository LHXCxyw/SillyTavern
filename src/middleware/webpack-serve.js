import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig from '../../webpack.config.js';

export default function getWebpackServeMiddleware() {
    /**
     * A very spartan recreation of webpack-dev-middleware.
     * @param {import('express').Request} req Request object.
     * @param {import('express').Response} res Response object.
     * @param {import('express').NextFunction} next Next function.
     * @type {import('express').RequestHandler}
     */
    function devMiddleware(req, res, next) {
        const publicLibConfig = getPublicLibConfig();
        const outputPath = publicLibConfig.output?.path;
        const outputFile = publicLibConfig.output?.filename;
        const parsedPath = path.parse(req.path);

        if (req.method === 'GET' && parsedPath.dir === '/' && parsedPath.base === outputFile) {
            return res.sendFile(outputFile, { root: outputPath });
        }

        next();
    }

    /**
     * Wait until Webpack is done compiling.
     * @param {object} param Parameters.
     * @param {boolean} [param.forceDist=false] Whether to force the use the /dist folder.
     * @param {boolean} [param.pruneCache=false] Whether to prune old cache directories before compiling.
     * @returns {Promise<void>}
     */
    devMiddleware.runWebpackCompiler = ({ forceDist = false, pruneCache = false } = {}) => {
        console.log();
        console.log('Compiling frontend libraries...');

        const publicLibConfig = getPublicLibConfig({ forceDist, pruneCache });
        const compiler = webpack(publicLibConfig);

        return new Promise((resolve) => {
            compiler.run((error, stats) => {
                // #region debug-point webpack-error-detail
                // 捕获并输出编译错误（之前 _error 被忽略，导致丢失关键诊断信息）
                if (error) {
                    console.error('========== WEBPACK COMPILE ERROR ==========');
                    console.error(error);
                    console.error('============================================');
                }
                if (stats) {
                    const output = stats.toString(publicLibConfig.stats);
                    if (output) {
                        console.log(output);
                        console.log();
                    }
                    // 当有编译错误时，输出详细信息以定位具体出错的模块
                    if (stats.hasErrors()) {
                        console.error('========== DETAILED WEBPACK ERRORS ==========');
                        const detailedOutput = stats.toString({
                            preset: 'detailed',
                            colors: false,
                            errors: true,
                            warnings: false,
                            modules: true,
                            reasons: true,
                            usedExports: true,
                            providedExports: true,
                        });
                        console.error(detailedOutput);
                        const statsJson = stats.toJson({ preset: 'detailed', errors: true });
                        console.error('========== ERRORS JSON ==========');
                        console.error(JSON.stringify(statsJson.errors, null, 2));
                        console.error('==============================================');
                    }
                }
                // #endregion debug-point webpack-error-detail
                compiler.close(() => {
                    resolve();
                });
            });
        });
    };

    return devMiddleware;
}
