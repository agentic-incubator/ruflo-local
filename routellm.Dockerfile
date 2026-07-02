FROM python:3.11-slim
RUN pip install --no-cache-dir "routellm[serve]"
EXPOSE 6060
