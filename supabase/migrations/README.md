# Database-migrationer

Denne mappe er den autoritative kilde til databaseskemaet. Filerne koeres i
numerisk raekkefoelge (001, 002, 003, ...) i Supabase' SQL Editor, naar et
frisk projekt skal saettes op.

Filerne er **allerede** anvendt paa det eksisterende produktionsprojekt — de
er en optegnelse over den nuvaerende tilstand, ikke noget der skal koeres der
igen. Koer dem kun mod en helt ny, tom database.

## Nye skemaaendringer

Migrationerne er **append-only**. En aendring laves ved at tilfoeje en ny
nummereret fil (fx `004_...sql`) — aldrig ved at redigere en eksisterende fil.
Saadan bliver historikken et sandt spejl af, hvad der er koert mod databasen.

## Hvorfor eksplicitte grants?

Projektet har **"Automatically expose new tables" slaaet fra** i Supabase.
Derfor slutter hver migration, der opretter en tabel, med eksplicitte grants
til `service_role`. Uden dem fejler tabellen med "permission denied", naar
appen (der bruger service-role-noeglen) forsoeger at laese eller skrive.
Husk grants til `service_role` i enhver ny migration, der opretter en tabel.
