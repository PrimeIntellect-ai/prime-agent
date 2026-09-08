FROM python:3.12-alpine
WORKDIR /opt/lab
COPY runner_harness.py /opt/lab/runner_harness.py
USER 65534:65534
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONHASHSEED=0
ENTRYPOINT ["python", "-I", "/opt/lab/runner_harness.py"]
