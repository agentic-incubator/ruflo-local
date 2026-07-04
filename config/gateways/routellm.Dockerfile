FROM python:3.14-slim
RUN pip install --no-cache-dir "routellm[serve]"
EXPOSE 6060
