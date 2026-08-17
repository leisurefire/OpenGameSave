// webpack.renderer.config.js
const path = require('path');

const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');


const isProduction = process.env.NODE_ENV === 'production';
const htmlMinifyOptions = isProduction ? {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: false,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    useShortDoctype: true,
} : false;

module.exports = {
    mode: isProduction ? 'production' : 'development',
    target: 'electron-renderer',
    devtool: isProduction ? false : 'source-map',
    entry: {
        index: './src/renderer/index.entry.js',
        settings: './src/renderer/settings.entry.js',
        about: './src/renderer/about.entry.js',
        modal: './src/renderer/modal.entry.js',
        menu: './src/renderer/menu.entry.js',
    },
    output: {
        path: path.resolve(__dirname, 'dist/out/renderer'),
        filename: 'js/[name].bundle.js',
        chunkFilename: 'js/[name].chunk.js',
        globalObject: 'self',
    },

    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: ['@babel/preset-env'],
                    },
                },
            },
            {
                // This rule handles compiled Tailwind and shared renderer CSS.
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, 'css-loader'],
            },
        ],
    },

    plugins: [
        // --- Create a new HtmlWebpackPlugin for EACH of the pages ---
        new HtmlWebpackPlugin({
            template: './src/renderer/index.html',  // Path to the source HTML
            filename: 'index.html',                 // Name of the output HTML in 'dist/out/renderer/'
            chunks: ['index'],                      // IMPORTANT: Inject only the 'index' JavaScript bundle
            minify: htmlMinifyOptions,
        }),
        new HtmlWebpackPlugin({
            template: './src/renderer/settings.html',
            filename: 'settings.html',
            chunks: ['settings'],
            minify: htmlMinifyOptions,
        }),
        new HtmlWebpackPlugin({
            template: './src/renderer/about.html',
            filename: 'about.html',
            chunks: ['about'],
            minify: htmlMinifyOptions,
        }),
        new HtmlWebpackPlugin({
            template: './src/renderer/modal.html',
            filename: 'modal.html',
            chunks: ['modal'],
            minify: htmlMinifyOptions,
        }),
        new HtmlWebpackPlugin({
            template: './src/renderer/menu.html',
            filename: 'menu.html',
            chunks: ['menu'],
            minify: htmlMinifyOptions,
        }),

        new MiniCssExtractPlugin({
            filename: 'css/[name].styles.css',
        }),


    ].filter(Boolean),
};
