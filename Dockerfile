# Node 22 on Alpine: the whole service is one file with no dependencies, so
# there is nothing to install and nothing to audit.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs .

# Free tiers set PORT themselves; 8001 matches the local yente port so the
# same URLs work either way.
ENV PORT=8001
EXPOSE 8001

# Non-root. Nothing here needs privileges, and a container that screens
# payments is not the place to skip that.
USER node

CMD ["node", "server.mjs"]
