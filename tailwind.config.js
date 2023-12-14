module.exports = {
  content: ['./views/**/*.html', './public/js/**/*.js',
      "./node_modules/tw-elements/dist/js/**/*.js"
    ],
    plugins: [require("tw-elements/dist/plugin.cjs")],
    darkMode: "class"
  };