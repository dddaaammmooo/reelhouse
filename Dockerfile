FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/10-medialoader-config.sh /docker-entrypoint.d/10-medialoader-config.sh
RUN sed -i 's/\r$//' /docker-entrypoint.d/10-medialoader-config.sh \
 && chmod +x /docker-entrypoint.d/10-medialoader-config.sh

COPY index.html icon.png /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js

EXPOSE 80
