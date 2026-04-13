## GraalJS JAR Editing (OBSOLETE)

The META-INF/services cross-registration hack was needed for GraalJS 22.3.1 where
`js` and `regex` JARs each needed the other's `TruffleLanguage$Provider` registered.

As of GraalJS 24.1.2, the service discovery mechanism changed to
`TruffleLanguageProvider` and each JAR registers its own provider independently.
No JAR editing is required.
