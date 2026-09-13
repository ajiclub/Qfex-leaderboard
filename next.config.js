/** @type {import('next').NextConfig} */
module.exports = {
  async redirects() {
    // A raiz abre o painel, que é estático e vive em public/.
    return [{ source: "/", destination: "/board.html", permanent: false }];
  },
};
