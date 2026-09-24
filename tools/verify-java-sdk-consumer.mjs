import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function parseArgs(raw) {
  const values = new Map();
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index];
    const value = raw[index + 1];
    if (!['--candidate', '--output'].includes(key) || !value || values.has(key)) {
      throw new Error('Use --candidate <directory> --output <report.json>.');
    }
    values.set(key, value);
  }
  if (!values.has('--candidate') || !values.has('--output')) {
    throw new Error('Java SDK consumer probe arguments are incomplete.');
  }
  return { candidate: resolve(values.get('--candidate')), output: resolve(values.get('--output')) };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runMaven(project, repository, ...args) {
  const command = ['-q', `-Dmaven.repo.local=${repository}`, ...args];
  execFileSync(process.platform === 'win32' ? 'mvn.cmd' : 'mvn', command, {
    cwd: project,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

async function main() {
  const { candidate, output } = parseArgs(process.argv.slice(2));
  const manifestPath = join(candidate, 'java-candidate-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== '1' || manifest.candidateKind !== 'maven-java-sdk') {
    throw new Error('Candidate manifest is not a Maven Java SDK candidate.');
  }
  const version = manifest.releaseVersion;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Candidate release version is invalid.');
  }
  const jarRelativePath = `maven/capture-runtime-client-${version}.jar`;
  const pomRelativePath = 'maven/pom.xml';
  const resourceRelativePath = 'maven/capture-runtime-contract-set.sha256';
  const jarPath = join(candidate, jarRelativePath);
  const pomPath = join(candidate, pomRelativePath);
  const resourcePath = join(candidate, resourceRelativePath);
  const jarBytes = await readFile(jarPath);
  const pom = await readFile(pomPath, 'utf8');
  const contractSetSha256 = String(manifest.contractSetSha256);
  if (!/^[0-9a-f]{64}$/u.test(contractSetSha256)) {
    throw new Error('Candidate contract-set digest is invalid.');
  }
  if (!pom.includes(`<groupId>${manifest.coordinates.groupId}</groupId>`)
      || !pom.includes(`<artifactId>${manifest.coordinates.artifactId}</artifactId>`)
      || !pom.includes(`<version>${version}</version>`)) {
    throw new Error('Candidate POM identity does not match its manifest.');
  }
  const jarSha256 = sha256(jarBytes);
  const manifestJar = manifest.artifacts?.find((artifact) => artifact.path === jarRelativePath);
  if (!manifestJar || manifestJar.sha256 !== jarSha256 || manifestJar.bytes !== jarBytes.length) {
    throw new Error('Candidate manifest does not bind the candidate JAR bytes.');
  }
  if ((await readFile(resourcePath, 'utf8')).trim() !== contractSetSha256) {
    throw new Error('Candidate contract resource differs from its manifest digest.');
  }
  const listing = execFileSync(
    process.platform === 'win32' ? 'jar.exe' : 'jar',
    ['tf', jarPath],
    { encoding: 'utf8' },
  ).split(/\r?\n/u);
  for (const entry of [
    'com/gx/capture/runtime/client/CaptureRuntimeTypes.class',
    'com/gx/capture/runtime/client/CaptureRuntimeTypes$StartCapture.class',
    'com/gx/capture/runtime/client/CaptureRuntimeTypes$CaptureOcrProjection.class',
    'capture-runtime-contract-set.sha256',
  ]) {
    if (!listing.includes(entry)) throw new Error(`Candidate JAR is missing ${entry}.`);
  }

  const probeRoot = await mkdtemp(join(tmpdir(), 'capture-java-consumer-'));
  const repository = join(probeRoot, 'maven-repository');
  const sourceRoot = join(probeRoot, 'src', 'test', 'java', 'com', 'gx', 'capture', 'probe');
  try {
    await writeFile(
      join(probeRoot, 'pom.xml'),
      `<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.gx.capture.probe</groupId>
  <artifactId>capture-runtime-java-consumer-probe</artifactId>
  <version>1.0.0</version>
  <properties><maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
  <dependencies>
    <dependency><groupId>com.gx.capture</groupId><artifactId>capture-runtime-client</artifactId><version>${version}</version></dependency>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>6.0.2</version><scope>test</scope></dependency>
  </dependencies>
  <build><plugins>
    <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.14.0</version><configuration><release>25</release></configuration></plugin>
    <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.5.3</version><configuration><useModulePath>false</useModulePath></configuration></plugin>
  </plugins></build>
</project>
`,
      'utf8',
    );
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, 'CandidateIdentityTest.java'),
      `package com.gx.capture.probe;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.gx.capture.runtime.client.CaptureRuntimeClient;
import com.gx.capture.runtime.client.CaptureRuntimeTypes;
import java.io.InputStream;
import java.lang.reflect.RecordComponent;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

class CandidateIdentityTest {
  private static final String EXPECTED_JAR_SHA256 = "${jarSha256}";
  private static final String EXPECTED_CONTRACT_SHA256 = "${contractSetSha256}";

  @Test
  void MavenLoadsTheExactCandidateClassesAndCurrentContractSurface() throws Exception {
    var location = CaptureRuntimeTypes.class.getProtectionDomain().getCodeSource().getLocation();
    assertNotNull(location);
    var jar = Path.of(new URI(location.toString()));
    assertEquals(EXPECTED_JAR_SHA256, digest(Files.readAllBytes(jar)));
    assertEquals(EXPECTED_CONTRACT_SHA256, CaptureRuntimeTypes.CONTRACT_SET_SHA256);
    try (InputStream resource = CaptureRuntimeTypes.class.getResourceAsStream("/capture-runtime-contract-set.sha256")) {
      assertNotNull(resource);
      assertEquals(EXPECTED_CONTRACT_SHA256, new String(resource.readAllBytes()).trim());
    }

    assertTrue(Arrays.stream(CaptureRuntimeTypes.StartCapture.class.getRecordComponents())
        .map(RecordComponent::getName).toList().contains("pdfPageNumbers"));
    var request = new CaptureRuntimeTypes.StartCapture(
        "2", "request-1", "ingestion-1", CaptureRuntimeTypes.StructuringMode.RUNTIME,
        null, "eager", List.of(1));
    assertTrue(new ObjectMapper().writeValueAsString(request).contains("\\\"pdfPageNumbers\\\":[1]"));

    var upload = new CaptureRuntimeClient.CaptureUpload(
        "scan.pdf", new byte[] {1}, "application/pdf", CaptureRuntimeTypes.SourceKind.PDF,
        null, CaptureRuntimeTypes.StructuringMode.RUNTIME, "request-1", List.of(1));
    assertEquals(List.of(1), upload.pdfPageNumbers());
    assertTrue(Arrays.stream(CaptureRuntimeTypes.CaptureOcrProjection.class.getRecordComponents())
        .map(RecordComponent::getName).toList().containsAll(List.of("pages", "contractSha256")));
    assertEquals(jar.toAbsolutePath(), Path.of(new URI(CaptureRuntimeTypes.CaptureOcrProjection.class
        .getProtectionDomain().getCodeSource().getLocation().toString())).toAbsolutePath());
  }

  private static String digest(byte[] bytes) throws Exception {
    return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }
}
`,
      'utf8',
    );
    runMaven(probeRoot, repository, 'org.apache.maven.plugins:maven-install-plugin:3.1.4:install-file',
      `-Dfile=${jarPath}`, `-DpomFile=${pomPath}`, '-DcreateChecksum=true');
    runMaven(probeRoot, repository, 'test');
    const manifestSha256 = sha256(manifestBytes);
    await writeFile(
      output,
      `${JSON.stringify({
        schemaVersion: '1',
        evidenceTier: 'local-probe',
        publicationStatus: 'not-published',
        candidateId: manifest.candidateId,
        candidateManifestSha256: manifestSha256,
        releaseVersion: version,
        coordinates: manifest.coordinates,
        contractSetSha256,
        jar: { path: jarRelativePath, bytes: jarBytes.length, sha256: jarSha256 },
        pom: { path: pomRelativePath, sha256: sha256(Buffer.from(pom)) },
        consumer: {
          result: 'passed',
          loadedJarSha256: jarSha256,
          loadedContractSetSha256: contractSetSha256,
        },
        cleanup: { isolatedRepositoryRemoved: true },
      }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`Verified local-probe Maven consumer against ${jarPath} (${jarSha256}).\n`);
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
