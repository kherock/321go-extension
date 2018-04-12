'use strict';

const CssExtractPlugin = require('mini-css-extract-plugin');
const OptimizeCSSAssetsPlugin = require('optimize-css-assets-webpack-plugin');
const UglifyJsPlugin = require('uglifyjs-webpack-plugin');
const path = require('path');
const { EnvironmentPlugin } = require('webpack');

module.exports = env => ({
  entry: {
    '321go': path.join(__dirname, './src/321go.js'),
    'background': path.join(__dirname, './src/background.js'),
    'popup/popup': path.join(__dirname, './src/popup/popup.js'),
  },
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].js',
  },
  mode: env || 'development',
  devtool: env === 'production' ? 'inline-source-map' : 'inline-cheap-module-source-map',
  optimization: {
    minimizer: [
      new UglifyJsPlugin({
        cache: true,
        parallel: true,
        sourceMap: env !== 'production',
        extractComments: true,
      }),
      new OptimizeCSSAssetsPlugin({
        cssProcessor: require('cssnano'),
        cssProcessorOptions: {
          map: env !== 'production',
        },
      }),
    ],
  },
  module: {
    rules: [
      {
        test: /\.scss$/,
        use: [
          CssExtractPlugin.loader,
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1,
              sourceMap: true,
            },
          },
          {
            loader: 'sass-loader',
            options: {
              sourceMap: true,
              includePaths: [path.join(__dirname, 'node_modules')],
            },
          },
        ],
      },
    ],
  },
  plugins: [
    new CssExtractPlugin({
      filename: '[name].css',
    }),
    new EnvironmentPlugin({
      ENDPOINT: env === 'offline'
        ? 'http://localhost:4000'
        : 'https://321go.gq',
    }),
  ],
});
