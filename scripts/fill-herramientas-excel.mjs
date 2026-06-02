import XLSX from 'xlsx';
import fs from 'fs';

const outPath = 'C:\\Users\\dcald\\Downloads\\Herramientas desarrollo local 2.xlsx';
const copyPath = 'd:\\Daniel\\APLICACIONES VARIAS\\Herramientas-desarrollo-entorno-nuevo.xlsx';

// Referencia portfolio: D:\AENA\proyect\ddceu-gala-*
const REF_PROYECTOS =
  'Portfolio AENA (D:\\AENA\\proyect): ddceu-gala-java-gala-web (Java 11, WAR MVC), ddceu-gala-java-gala-listablanca-batch (Java 11, Spring Batch), ddceu-gala-java-gala-parking / ddceu-gala-java-caven-backend (Java 11, REST/WAR), ddceu-gala-java-gala-serviciosweb (Java 21, SOAP+Oracle), ddceu-gala-java-gala-caven-ws (Java 21, REST), ddceu-gala-angular-* (frontends), ddceu-gala-web-migration.';

const herramientas = [
  {
    categoria: 'IDE',
    herramienta: 'IntelliJ IDEA Community',
    version: 'Última versión estable disponible (catálogo corporativo)',
    uso:
      'Java: ddceu-gala-java-gala-web, listablanca-batch, parking, caven-backend (11); serviciosweb, caven-ws (21). Debug Maven WAR, Spring MVC/Boot, SOAP.',
    justificacion:
      `${REF_PROYECTOS} En el mismo día alterno Java 11 (gala-web, batch, parking) y Java 21 (serviciosweb SOAP, caven-ws). IntelliJ asigna SDK por proyecto sin reinstalar el entorno. Necesario para depurar MVC (Controller→Service→JPA/Oracle) y ejecutar tests con IA en el mismo ciclo.`,
    prioridad: 'Alta',
    notas: 'JetBrains Gateway si el código reside en VDI. Solicitar última versión estable al desplegar.',
  },
  {
    categoria: 'IDE',
    herramienta: 'Visual Studio Code',
    version: 'Última versión estable disponible (catálogo corporativo)',
    uso:
      'Frontends Angular: ddceu-gala-angular-web-externos-frontend, ddceu-gala-angular-caven-interno, ddceu-gala-angular-gala-caven-externo; YAML/API (ddceu-gala-api-wso2apimanager-gala-caven).',
    justificacion:
      `${REF_PROYECTOS} Complementa IntelliJ: TypeScript/Angular y configs no Java. No sustituye IntelliJ en WAR/SOAP/Batch Oracle. Convivencia de ambos IDEs en el entorno de desarrollo.`,
    prioridad: 'Alta',
    notas: 'Extension Pack for Java opcional como respaldo; Angular Language Service para proyectos ddceu-gala-angular-*.',
  },
  {
    categoria: 'Frontend / Build',
    herramienta: 'Angular CLI (ng)',
    version:
      'Alineada al proyecto: @angular/cli 16.x (ddceu-gala-angular-web-externos-frontend) y 15.x (ddceu-gala-angular-caven-interno / gala-caven-externo); vía npm local o global homologada por IT',
    uso:
      'ng serve / ng build / ng test en ddceu-gala-angular-web-externos-frontend, ddceu-gala-angular-caven-interno, ddceu-gala-angular-gala-caven-externo; perfiles dev, pre, pro, cis (proxy SSL)',
    justificacion:
      `${REF_PROYECTOS} Los frontends Angular no se compilan con Maven: requieren Angular CLI para desarrollo local (ng serve con proxy hacia APIs Java), builds por entorno (build.pre, build.pro) y tests (ng test, coverage). Sin ng en VDI no puedo validar integración front↔back (gala-web, caven-ws, WSO2) antes de pipeline.`,
    prioridad: 'Alta',
    notas:
      'Incluir Node.js LTS homologado + npm. Instalar dependencias con npm ci en cada repo. Versión de CLI debe coincidir con Angular del package.json (15 o 16), no forzar última CLI global si rompe proyectos legacy.',
  },
  {
    categoria: 'Runtime Java',
    herramienta: 'JDK 11 (Eclipse Temurin u OpenJDK)',
    version: '11.0.x LTS',
    uso: 'ddceu-gala-java-gala-web, ddceu-gala-java-gala-listablanca-batch, ddceu-gala-java-gala-parking, ddceu-gala-java-caven-backend (pom: java 11)',
    justificacion:
      'Repos activos en Java 11 con WAR y Spring Boot 2.7. Sin JDK 11 en paralelo con 21 no compilo ni ejecuto legacy mientras migro serviciosweb/caven-ws a 21.',
    prioridad: 'Alta',
    notas: 'Configurar toolchains Maven/Gradle por proyecto.',
  },
  {
    categoria: 'Runtime Java',
    herramienta: 'JDK 21 (Eclipse Temurin u OpenJDK)',
    version: '21 LTS',
    uso: 'ddceu-gala-java-gala-serviciosweb (Java 21, SOAP), ddceu-gala-java-gala-caven-ws (Java 21, Spring Boot 3.5)',
    justificacion:
      'Migración en curso: serviciosweb ya en 21 con spring-ws y ojdbc11; caven-ws en Boot 3.5. Debe coexistir con JDK 11 de gala-web y batch en la misma VDI.',
    prioridad: 'Alta',
    notas: 'Validar compatibilidad librerías JAXB/Jakarta en proyectos SOAP migrados.',
  },
  {
    categoria: 'Servidor aplicaciones',
    herramienta: 'Apache Tomcat',
    version: '9.0.100',
    uso: 'Desplegar WAR en VDI sin WebLogic: ddceu-gala-java-gala-web (Spring MVC WAR), batch/parking/serviciosweb (WAR provided scope)',
    justificacion:
      'En producción el target es WebLogic 14; en desarrollo uso Tomcat 9.0.100 para levantar gala-web y WARs sin desplegar en servidor corporativo. caven-ws excluye tomcat-embed para despliegue externo: mismo Tomcat 9.0.100 unifica pruebas. Reinicio y debug en minutos, no por ticket de despliegue.',
    prioridad: 'Alta',
    notas: 'Alinear versión con target WebLogic 14; documentar datasource JNDI o equivalente Spring.',
  },
  {
    categoria: 'Build',
    herramienta: 'Apache Maven',
    version: '3.9.x',
    uso: 'Build, empaquetado WAR/JAR, dependencias, perfiles dev/test, ejecución tests',
    justificacion:
      'Estándar en proyectos Java corporativos. Integración nativa IntelliJ; necesario para batch, microservicios y gala-web.',
    prioridad: 'Alta',
    notas: 'Acceso a repositorio corporativo (Nexus/Artifactory) y caché local .m2.',
  },
  {
    categoria: 'Build',
    herramienta: 'Gradle',
    version: '8.x (si aplica en algún repo)',
    uso: 'Build alternativo en microservicios que usen Gradle',
    justificacion:
      'Algunos repos de migración pueden usar Gradle; misma lógica dual JDK 11/21.',
    prioridad: 'Media',
    notas: 'Solo si hay proyectos Gradle en el portfolio del equipo.',
  },
  {
    categoria: 'Control de versiones',
    herramienta: 'Git',
    version: '2.x',
    uso: 'Clone, ramas feature/hotfix, merge, push a remoto corporativo (GitLab/Azure DevOps/GitHub Enterprise)',
    justificacion:
      'Flujo diario: bugfix en rama legacy 11 y feature en rama migración 21. Sin Git integrado pierdo trazabilidad y paralelismo de trabajo.',
    prioridad: 'Alta',
    notas: 'Credenciales vía SSO/token corporativo; sin almacenar passwords en repos.',
  },
  {
    categoria: 'Control de versiones',
    herramienta: 'Integración Git en IntelliJ (+ Git Credential Manager)',
    version: 'Incluido en IDE / GCM',
    uso: 'Commit, diff, blame, merge conflicts, historial por clase desde IDE',
    justificacion:
      'Evita cambiar de herramienta en cada commit; revisión de cambios junto al debug del bug Oracle o SOAP.',
    prioridad: 'Alta',
    notas: 'Política de firmado de commits si la empresa lo exige.',
  },
  {
    categoria: 'Base de datos',
    herramienta: 'Oracle SQL Developer o DBeaver',
    version: 'Última estable',
    uso: 'Consultas Oracle pesadas, EXPLAIN PLAN, tuning, validación datos en dev/QA (vía CyberArk)',
    justificacion:
      'Desarrollo con consultas Oracle que demandan recursos: necesito iterar SQL muchas veces al día. Acceso desde VDI/sandbox (no desde laptop en claro), mismo ciclo que la app.',
    prioridad: 'Alta',
    notas: 'Conexión Oracle DEV/QA con rol CyberArk preaprobado para desarrollo.',
  },
  {
    categoria: 'Base de datos',
    herramienta: 'Oracle Instant Client + JDBC (ojdbc)',
    version: 'Compatible con versión servidor Oracle',
    uso: 'Conexión apps Java, batch y herramientas SQL al esquema dev',
    justificacion:
      'Sin cliente Oracle las apps y el IDE no conectan al esquema de desarrollo.',
    prioridad: 'Alta',
    notas: 'Coordinar versión con DBA.',
  },
  {
    categoria: 'API / Integración',
    herramienta: 'SoapUI (Open Source o ReadyAPI si licencia)',
    version: '5.x (última estable permitida)',
    uso: 'ddceu-gala-java-gala-serviciosweb: spring-ws, WSDL, generación contratos SOAP (pom plugins), ojdbc11/Oracle',
    justificacion:
      'serviciosweb con dependencias SOAP y plugin generación clases desde WSDL. Necesito enviar XML de prueba y validar respuestas en migración a Java 21 sin esperar despliegue en integración.',
    prioridad: 'Alta',
    notas: 'Acceso a endpoints de integración/stub en red dev.',
  },
  {
    categoria: 'API / Integración',
    herramienta: 'Postman',
    version: 'Última versión estable disponible (catálogo corporativo)',
    uso: 'REST: ddceu-gala-java-gala-caven-ws, ddceu-gala-java-caven-backend, ddceu-gala-java-gala-parking; APIs WSO2 (ddceu-gala-api-wso2apimanager-gala-caven)',
    justificacion:
      'Pruebo endpoints REST y gateways sin desplegar front Angular. Colecciones por entorno dev/QA para regresión en migración Java 11→21.',
    prioridad: 'Alta',
    notas: 'Variables de entorno dev/QA; sin secretos en colecciones compartidas.',
  },
  {
    categoria: 'Calidad / Tests',
    herramienta: 'JUnit 5 + Mockito (+ AssertJ si aplica)',
    version: 'Vía Maven/Gradle en proyectos',
    uso: 'Pruebas unitarias; generación/ajuste asistido por IA en IntelliJ',
    justificacion:
      'Ciclo corto: generar test → ejecutar en IDE → corregir. Sin ejecución local/VDI rápida la IA pierde utilidad.',
    prioridad: 'Alta',
    notas: 'Maven Surefire/Failsafe configurados en repos.',
  },
  {
    categoria: 'Calidad / Tests',
    herramienta: 'SonarLint (plugin IntelliJ)',
    version: 'Última estable',
    uso: 'Detección temprana de code smells y bugs antes de pipeline',
    justificacion:
      'Reduce fallos en SonarQube corporativo y acelera migración 21.',
    prioridad: 'Media',
    notas: 'Opcional: enlace a reglas Sonar del servidor corporativo.',
  },
  {
    categoria: 'Batch / Datos',
    herramienta: 'Espacio de ficheros + permisos ejecución batch en sandbox',
    version: 'N/A (capacidad entorno)',
    uso: 'Probar jobs batch con CSV/entrada local, logs, reintentos sin despliegue formal',
    justificacion:
      'Hoy ejecuto batch en local para validar mapeos y queries Oracle. En entorno remoto necesito directorio de entrada/salida editable y lanzamiento desde IntelliJ o CLI.',
    prioridad: 'Alta',
    notas: 'Cron simulado o trigger manual; credenciales batch vía CyberArk.',
  },
  {
    categoria: 'Contenedores (opcional)',
    herramienta: 'Docker Desktop o Docker en VDI',
    version: 'Última estable permitida',
    uso: 'Levantar varios microservicios + dependencias en local dev',
    justificacion:
      'Integración multi-servicio sin ocupar puertos en servidores compartidos; perfiles docker-compose dev.',
    prioridad: 'Media',
    notas: 'Solo si política de seguridad lo permite en VDI.',
  },
  {
    categoria: 'Utilidades',
    herramienta: '7-Zip / herramienta descompresión',
    version: 'Última',
    uso: 'WAR, JAR, logs exportados, ficheros batch',
    justificacion: 'Operativa diaria en soporte y despliegue local.',
    prioridad: 'Baja',
    notas: '',
  },
  {
    categoria: 'IA desarrollo (si política lo permite)',
    herramienta: 'Asistente IA corporativo o Copilot en IDE',
    version: 'Según licencia empresa',
    uso: 'Generación y refactor de pruebas unitarias, boilerplate, documentación técnica',
    justificacion:
      'Uso actual para acelerar tests unitarios; requiere poder ejecutar tests en el mismo entorno tras generar código.',
    prioridad: 'Media',
    notas: 'Código sensible solo dentro del perímetro aprobado.',
  },
  {
    categoria: 'Acceso seguro',
    herramienta: 'CyberArk (cliente / PAM)',
    version: 'Corporativa',
    uso: 'Credenciales Oracle, SSH, cuentas privilegiadas, secretos sin .properties en Git',
    justificacion:
      'Alineado con política de seguridad; sustituye passwords locales. Requiere sesiones JIT con duración suficiente para jornada de desarrollo.',
    prioridad: 'Alta',
    notas: 'No sustituye herramientas anteriores: las complementa con gobierno de accesos.',
  },
];

const contras = [
  {
    aspecto: 'Ciclo compilar → probar → depurar',
    hoy: 'Minutos en PC local: F5, breakpoint, reinicio Tomcat',
    entornoNuevo: 'Latencia VDI, recursos compartidos, posible prohibición debug → horas o dependencia de IT',
    impacto: 'Alto',
  },
  {
    aspecto: 'Acceso Oracle',
    hoy: 'Conexión directa dev/QA desde PC; muchas iteraciones SQL/día',
    entornoNuevo: 'Solo vía CyberArk/sandbox; tickets, MFA, expiración sesión',
    impacto: 'Alto',
  },
  {
    aspecto: 'Java 11 y 21 en paralelo',
    hoy: 'Cambio SDK por proyecto en IntelliJ al instante',
    entornoNuevo: 'Un solo JDK global o plantilla incorrecta → builds fallidos o bugs solo en un entorno',
    impacto: 'Alto',
  },
  {
    aspecto: 'gala-web MVC',
    hoy: 'Tomcat local simulando WebLogic; debug pantalla→DAO→Oracle en un flujo',
    entornoNuevo: 'Deploy en servidor compartido o sin Tomcat → sin prueba rápida de pantallas',
    impacto: 'Alto',
  },
  {
    aspecto: 'Servicios batch',
    hoy: 'Ejecución local con ficheros de prueba y logs inmediatos',
    entornoNuevo: 'Sin directorios editables o sin permiso ejecutar → cada prueba = despliegue',
    impacto: 'Alto',
  },
  {
    aspecto: 'Microservicios',
    hoy: 'Varios servicios en puertos locales / Docker Compose',
    entornoNuevo: 'Sandbox único compartido; conflictos de puertos/ramas',
    impacto: 'Medio-Alto',
  },
  {
    aspecto: 'SOAP',
    hoy: 'SoapUI + stubs locales; 10+ requests por cambio XML',
    entornoNuevo: 'Endpoints solo en red interna; certificados y WSDL no alineados con rama',
    impacto: 'Medio-Alto',
  },
  {
    aspecto: 'IDE único VS Code',
    hoy: 'IntelliJ para Java enterprise',
    entornoNuevo: 'VS Code sin mismo nivel refactor/debug MVC y multi-módulo',
    impacto: 'Alto',
  },
  {
    aspecto: 'Git',
    hoy: 'Push/pull inmediato desde misma máquina',
    entornoNuevo: 'Restricciones red, proxy, tokens; posible bloqueo plugins',
    impacto: 'Medio',
  },
  {
    aspecto: 'IA + tests unitarios',
    hoy: 'Generar → ejecutar test en IDE en segundos',
    entornoNuevo: 'Política IA restrictiva o tests solo en pipeline remoto',
    impacto: 'Medio',
  },
  {
    aspecto: '—— AUTONOMÍA (tickets IT): resumen ——',
    hoy: 'En PC local resuelvo yo mismo la mayoría de incidencias de entorno sin esperar a IT',
    entornoNuevo: 'Acciones habituales de migración/desarrollo pasan a depender de cola de tickets, aprobaciones y ventanas de cambio',
    impacto: 'Medio-Alto (transversal)',
  },
  {
    aspecto: 'Autonomía: instalar / actualizar dependencias Maven (migración o desarrollo nuevo)',
    hoy: 'Ej.: subir Spring Boot 2.7→3.x en ddceu-gala-java-gala-parking, añadir jakarta.* en serviciosweb, resolver conflictos en pom.xml, `mvn clean install` y refrescar .m2 local al momento',
    entornoNuevo: 'Repositorio Nexus/Artifactory con proxy restrictivo; artefacto no cacheado o versión bloqueada → ticket a IT para whitelist o sincronización; no puedo probar el cambio de dependencia hasta que aprueben',
    impacto: 'Alto en migración Java 21 y SOAP (serviciosweb, caven-ws)',
  },
  {
    aspecto: 'Autonomía: actualización de dependencias transitivas / plugins (JAXB, spring-ws, MapStruct, ojdbc)',
    hoy: 'Ajusto versiones en pom, regenero fuentes WSDL (serviciosweb), recompilo y ejecuto tests en IntelliJ el mismo día',
    entornoNuevo: 'Plugin Maven o librería no permitida en VDI; actualización de plugin de generación SOAP requiere validación seguridad → paraliza migración ddceu-gala-web-migration y repos Java 21',
    impacto: 'Alto',
  },
  {
    aspecto: 'Autonomía: acceso BD PRE y PRO para reproducir incidencias',
    hoy: 'Ante incidencia en producción/preproducción, conexión autorizada (VPN + credenciales) para consultas de diagnóstico, comparar datos y validar fix antes de desplegar (solo lectura o rol acotado según política)',
    entornoNuevo: 'Sin acceso desde entorno de desarrollo a PRE/PRO o solo vía CyberArk con ticket por sesión → imposible contrastar SQL Oracle pesado de gala-web/batch con datos reales de la incidencia; riesgo de fix incorrecto en DEV',
    impacto: 'Alto — incidencias críticas Oracle y batch (listablanca-batch)',
  },
  {
    aspecto: 'Autonomía: pruebas puntuales en PRE (validación pre-release)',
    hoy: 'Despliego o apunto perfil PRE en properties, ejecuto caso de prueba y verifico integración REST/SOAP (caven-ws, serviciosweb) antes de pasar a PRO',
    entornoNuevo: 'Despliegue a PRE solo por pipeline o ticket operaciones; desarrollador no dispara prueba en PRE → alarga ciclo de validación de migración',
    impacto: 'Medio-Alto',
  },
  {
    aspecto: 'Autonomía: variables de entorno y perfiles (dev / pre / pro)',
    hoy: 'Defino JAVA_OPTS, URLs de datasource, claves de perfil Spring (`spring.profiles.active`), variables en IntelliJ Run Configuration o .env local para batch y microservicios',
    entornoNuevo: 'Variables solo las inyecta IT en VDI/servidor; cambio de URL Oracle, puerto Tomcat o flag de feature → ticket y espera; error de variable mal cargada no se detecta hasta despliegue',
    impacto: 'Medio-Alto',
  },
  {
    aspecto: 'Autonomía: cambio de versión de Java (11 ↔ 21) por proyecto',
    hoy: 'En IntelliJ asigno SDK 11 a ddceu-gala-java-gala-web y SDK 21 a ddceu-gala-java-gala-serviciosweb / caven-ws; cambio en segundos entre proyectos abiertos',
    entornoNuevo: 'VDI con un solo JDK instalado o imagen fija → compilo con versión equivocada; solicitar instalación JDK adicional o cambio de imagen = ticket IT (días); bloquea trabajo paralelo legacy + migración',
    impacto: 'Alto',
  },
  {
    aspecto: 'Autonomía: plugins IDE, drivers Oracle, SoapUI/Postman',
    hoy: 'Instalo/actualizo cuando hace falta para la tarea (nuevo driver ojdbc, plugin Lombok, SoapUI para WSDL)',
    entornoNuevo: 'Catálogo software cerrado; cada herramienta nueva o actualización mayor → solicitud formal',
    impacto: 'Medio',
  },
  {
    aspecto: 'Autonomía: reinicio Tomcat 9.0.100 y ficheros batch de prueba',
    hoy: 'Reinicio Tomcat tras cambio WAR; ejecuto listablanca-batch con CSV de entrada en carpeta local',
    entornoNuevo: 'Reinicio de servicio o escritura en directorio de entrada del batch requiere permiso operador o ticket',
    impacto: 'Alto (gala-web, listablanca-batch)',
  },
  {
    aspecto: 'Migración 11→21',
    hoy: 'Mismo día: hotfix 11 y feature 21',
    entornoNuevo: 'Colas de entorno o una sola imagen VDI retrasa ambas líneas de trabajo',
    impacto: 'Alto',
  },
];

const headersHerramientas = [
  'Categoría',
  'Herramienta',
  'Versión recomendada',
  'Uso en proyectos (gala-web / batch / microservicios / SOAP / Oracle)',
  'Justificación técnica',
  'Prioridad',
  'Notas / Dependencias IT',
];

const headersContras = [
  'Aspecto',
  'Situación actual (PC local)',
  'Entorno nuevo (CyberArk / VDI / remoto)',
  'Impacto en productividad',
];

const rowsHerramientas = [
  headersHerramientas,
  ...herramientas.map((h) => [
    h.categoria,
    h.herramienta,
    h.version,
    h.uso,
    h.justificacion,
    h.prioridad,
    h.notas,
  ]),
];

const rowsContras = [
  ['CONTRAS: entorno nuevo frente a desarrollo local actual'],
  [],
  headersContras,
  ...contras.map((c) => [c.aspecto, c.hoy, c.entornoNuevo, c.impacto]),
  [],
  [
    'Resumen solicitud',
    `Replicar en VDI/sandbox (CyberArk) el ciclo sobre D:\\AENA\\proyect\\ddceu-gala-*: IntelliJ+VS Code+Angular CLI (ng)+Node.js, JDK 11.0.31/21.0.11, Tomcat 9.0.100, Oracle, Git, SoapUI, Postman. Autonomía mínima: Maven/npm, PRE/PRO CyberArk, variables entorno, JDK dual, reinicio Tomcat/batch. Ver hoja contras AUTONOMÍA.`,
  ],
];

const wb = XLSX.utils.book_new();
const ws1 = XLSX.utils.aoa_to_sheet(rowsHerramientas);
const ws2 = XLSX.utils.aoa_to_sheet(rowsContras);

ws1['!cols'] = [
  { wch: 18 },
  { wch: 28 },
  { wch: 22 },
  { wch: 45 },
  { wch: 55 },
  { wch: 10 },
  { wch: 40 },
];
ws2['!cols'] = [{ wch: 28 }, { wch: 40 }, { wch: 45 }, { wch: 18 }];

XLSX.utils.book_append_sheet(wb, ws1, 'Herramientas solicitadas');
XLSX.utils.book_append_sheet(wb, ws2, 'Contras vs entorno actual');

const log = [];
try {
  XLSX.writeFile(wb, copyPath);
  log.push('OK copy: ' + copyPath);
} catch (e) {
  log.push('ERR copy: ' + e.message);
}
try {
  XLSX.writeFile(wb, outPath);
  log.push('OK out: ' + outPath);
} catch (e) {
  log.push('ERR out: ' + e.message);
}
fs.writeFileSync('d:\\Daniel\\APLICACIONES VARIAS\\scripts\\excel-fill-done.log', log.join('\n'), 'utf8');
